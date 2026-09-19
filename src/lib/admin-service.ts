import { createHash } from "node:crypto";
import { Prisma, type Market } from "@prisma/client";
import { z } from "zod";

import { initialSubsidyMilli } from "@/lib/market-maker";
import { ApiError, consumeRateLimit, prisma } from "@/lib/market-service";
import { drainMarketOrderBook } from "@/lib/order-exchange";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

const MARKET_STATUSES = ["DRAFT", "OPEN", "PAUSED", "CLOSED", "RESOLVING", "RESOLVED", "VOID"] as const;
const TREASURY_OWNER_ID = "treasury";
const TREASURY_PURPOSE = "TREASURY";

const cleanText = (minimum: number, maximum: number) =>
  z
    .string()
    .trim()
    .min(minimum)
    .max(maximum)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
      message: "Text contains unsupported control characters.",
    });

const instantSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));

export const createMarketSchema = z
  .object({
    slug: z.string().trim().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    title: cleanText(10, 240),
    shortTitle: cleanText(3, 90),
    description: cleanText(20, 5_000),
    rules: cleanText(20, 10_000),
    resolutionSource: cleanText(3, 2_000),
    category: cleanText(2, 60),
    eventId: z.string().cuid().nullable().optional(),
    status: z.enum(["DRAFT", "OPEN"]).default("DRAFT"),
    featured: z.boolean().default(false),
    color: z.enum(["gold", "green", "blue", "sky", "orange", "red", "violet"]).default("gold"),
    icon: z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/).default("sparkles"),
    closesAt: instantSchema,
    resolvesAt: instantSchema,
    pricingModel: z.enum(["LMSR", "ORDER_BOOK"]).default("LMSR"),
    liquidityParameter: z.number().int().min(1).max(1_000_000).default(40),
    payoutMilli: z.literal("100000").transform((value) => BigInt(value)).default(100_000n),
    feeBps: z.number().int().min(0).max(1_000).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resolvesAt < value.closesAt) {
      context.addIssue({ code: "custom", path: ["resolvesAt"], message: "Resolution cannot precede close." });
    }
    if (value.status === "OPEN" && value.closesAt <= new Date()) {
      context.addIssue({ code: "custom", path: ["closesAt"], message: "An open market must close in the future." });
    }
  });

export const lifecycleReasonSchema = z.object({ reason: cleanText(3, 1_000), expectedVersion: z.number().int().nonnegative() }).strict();

export const resolutionSchema = z
  .object({
    outcome: z.enum(["YES", "NO", "VOID"]),
    reason: cleanText(10, 2_000),
    evidence: cleanText(3, 2_000),
  })
  .strict();

type ParsedCreateMarketInput = z.infer<typeof createMarketSchema>;
type CreateMarketInput = Omit<ParsedCreateMarketInput, "pricingModel"> & {
  /** Direct service callers from before pricing-model selection remain LMSR. */
  pricingModel?: ParsedCreateMarketInput["pricingModel"];
};
type ResolutionInput = z.infer<typeof resolutionSchema>;
type LifecycleAction = "PAUSE" | "RESUME" | "CLOSE";
type ResolutionConflictCode = "PROPOSER_CONFLICT" | "RESOLVER_CONFLICT";

async function treasuryAccount(tx: Prisma.TransactionClient) {
  return tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: TREASURY_OWNER_ID,
        purpose: TREASURY_PURPOSE,
      },
    },
    create: {
      ownerType: "SYSTEM",
      ownerId: TREASURY_OWNER_ID,
      purpose: TREASURY_PURPOSE,
      allowsNegative: true,
    },
    update: {},
  });
}

export async function requireActiveAdmin(tx: Prisma.TransactionClient, actorUserId: string): Promise<void> {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, status: true },
  });
  if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
    throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
  }
}

export async function assertNoResolutionTradingExposure(
  tx: Pick<Prisma.TransactionClient, "trade" | "orderFill">,
  userId: string,
  marketId: string,
  conflictCode: ResolutionConflictCode,
): Promise<void> {
  const [legacyTradeCount, orderFillCount] = await Promise.all([
    tx.trade.count({ where: { userId, marketId } }),
    tx.orderFill.count({
      where: {
        marketId,
        OR: [
          { makerOrder: { is: { userId } } },
          { takerOrder: { is: { userId } } },
        ],
      },
    }),
  ]);

  if (legacyTradeCount > 0 || orderFillCount > 0) {
    const role = conflictCode === "PROPOSER_CONFLICT" ? "propose its result" : "resolve it";
    throw new ApiError(403, conflictCode, `An administrator who traded this market cannot ${role}.`);
  }
}

function assertBalanced(postings: Array<{ amountMilli: bigint }>): void {
  if (postings.length < 2 || postings.some((posting) => posting.amountMilli === 0n)) {
    throw new Error("Financial journal entries require at least two non-zero postings");
  }
  if (postings.reduce((total, posting) => total + posting.amountMilli, 0n) !== 0n) {
    throw new Error("Refusing to create an unbalanced journal entry");
  }
}

function publicMarket(market: Market) {
  return {
    id: market.id,
    slug: market.slug,
    status: market.status,
    pricingModel: market.pricingModel,
    resolution: market.resolution,
    version: market.version,
    closesAt: market.closesAt,
    resolvesAt: market.resolvesAt,
    resolvedAt: market.resolvedAt,
  };
}

export async function createAdminMarket(input: {
  actorUserId: string;
  idempotencyKey: string;
  market: CreateMarketInput;
}) {
  await consumeRateLimit(prisma, `admin-market-create:${input.actorUserId}`, 10, 60_000);
  const operationAt = new Date();
  const idempotencyExpiresAt = new Date(operationAt.getTime() + 24 * 60 * 60 * 1_000);
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const normalizedMarket: ParsedCreateMarketInput = {
      ...input.market,
      pricingModel: input.market.pricingModel ?? "LMSR",
    };
    // Administrative idempotency is principal-scoped: one administrator must
    // never be able to replay or conflict with another administrator's request.
    const scope = `ADMIN_MARKET_CREATE:${input.actorUserId}`;
    const route = "/api/admin/markets";
    const requestHash = createHash("sha256").update(jsonStringify(normalizedMarket)).digest("hex");
    const { pricingModel: _pricingModel, ...legacyMarket } = normalizedMarket;
    void _pricingModel;
    const legacyRequestHash = createHash("sha256").update(jsonStringify(legacyMarket)).digest("hex");
    const existingRequest = await tx.idempotencyRequest.findUnique({
      where: { userId_route_key: { userId: input.actorUserId, route, key: input.idempotencyKey } },
    });
    if (existingRequest) {
      if (existingRequest.requestHash !== requestHash) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another market request.");
      }
      if (existingRequest.status === "COMPLETED" && existingRequest.responseBody) {
        const stored = JSON.parse(existingRequest.responseBody) as {
          market: ReturnType<typeof publicMarket>;
          subsidyMilli: string;
        };
        return {
          market: {
            ...stored.market,
            closesAt: new Date(stored.market.closesAt),
            resolvesAt: new Date(stored.market.resolvesAt),
            resolvedAt: stored.market.resolvedAt ? new Date(stored.market.resolvedAt) : null,
          },
          subsidyMilli: BigInt(stored.subsidyMilli),
          replayed: true,
        };
      }
      throw new ApiError(409, "REQUEST_IN_PROGRESS", "This market request is already being processed.");
    }

    const previous = await tx.journalEntry.findUnique({
      where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey: input.idempotencyKey } },
    });
    if (previous) {
      const metadata = JSON.parse(previous.metadata) as { requestHash?: string; subsidyMilli?: string };
      const legacyLmsrReplay = normalizedMarket.pricingModel === "LMSR" && metadata.requestHash === legacyRequestHash;
      if (metadata.requestHash !== requestHash && !legacyLmsrReplay) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another market request.");
      }
      const market = await tx.market.findUnique({ where: { id: previous.referenceId } });
      if (!market) throw new Error("Idempotent market journal references a missing market");
      const replay = {
        market: publicMarket(market),
        subsidyMilli: BigInt(metadata.subsidyMilli ?? "0"),
        replayed: true,
      };
      await tx.idempotencyRequest.create({
        data: {
          userId: input.actorUserId,
          route,
          key: input.idempotencyKey,
          requestHash,
          status: "COMPLETED",
          responseCode: 201,
          responseBody: jsonStringify({ ...replay, replayed: false }),
          expiresAt: idempotencyExpiresAt,
        },
      });
      return replay;
    }
    await tx.idempotencyRequest.create({
      data: {
        userId: input.actorUserId,
        route,
        key: input.idempotencyKey,
        requestHash,
        expiresAt: idempotencyExpiresAt,
      },
    });

    const orderBook = normalizedMarket.pricingModel === "ORDER_BOOK";
    const subsidyMilli = orderBook
      ? 0n
      : initialSubsidyMilli(normalizedMarket.liquidityParameter, normalizedMarket.payoutMilli);
    if (normalizedMarket.eventId) {
      const eventExists = await tx.marketEvent.count({ where: { id: normalizedMarket.eventId } });
      if (!eventExists) throw new ApiError(404, "EVENT_NOT_FOUND", "The selected event does not exist.");
    }
    const treasury = orderBook ? null : await treasuryAccount(tx);
    const { eventId, ...marketData } = normalizedMarket;
    const market = await tx.market.create({
      data: {
        ...marketData,
        event: eventId ? { connect: { id: eventId } } : undefined,
        createdBy: { connect: { id: input.actorUserId } },
        collateralAccount: {
          create: {
            ownerType: "MARKET",
            purpose: "COLLATERAL",
            balanceMilli: subsidyMilli,
          },
        },
        priceHistory: orderBook ? undefined : { create: { yesProbabilityBps: 5_000 } },
      },
      include: { collateralAccount: true },
    });
    await tx.ledgerAccount.update({
      where: { id: market.collateralAccountId },
      data: { ownerId: market.id },
    });
    if (treasury) {
      await tx.ledgerAccount.update({
        where: { id: treasury.id },
        data: { balanceMilli: { decrement: subsidyMilli } },
      });
      const postings = [
        { ledgerAccountId: treasury.id, amountMilli: -subsidyMilli },
        { ledgerAccountId: market.collateralAccountId, amountMilli: subsidyMilli },
      ];
      assertBalanced(postings);
      await tx.journalEntry.create({
        data: {
          type: "MARKET_SUBSIDY",
          referenceType: "MARKET",
          referenceId: market.id,
          idempotencyScope: scope,
          idempotencyKey: input.idempotencyKey,
          actorUserId: input.actorUserId,
          metadata: jsonStringify({ subsidyMilli, liquidityParameter: market.liquidityParameter, requestHash }),
          postings: { create: postings },
        },
      });
    }
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "MARKET_CREATED",
        entityType: "MARKET",
        entityId: market.id,
        metadata: jsonStringify({ status: market.status, pricingModel: market.pricingModel, subsidyMilli }),
      },
    });
    const result = { market: publicMarket(market), subsidyMilli, replayed: false };
    await tx.idempotencyRequest.update({
      where: { userId_route_key: { userId: input.actorUserId, route, key: input.idempotencyKey } },
      data: { status: "COMPLETED", responseCode: 201, responseBody: jsonStringify(result) },
    });
    return result;
  });
}

const lifecycleRules: Record<LifecycleAction, { from: string[]; to: string }> = {
  PAUSE: { from: ["OPEN"], to: "PAUSED" },
  RESUME: { from: ["PAUSED"], to: "OPEN" },
  CLOSE: { from: ["DRAFT", "OPEN", "PAUSED"], to: "CLOSED" },
};

export async function transitionAdminMarket(input: {
  actorUserId: string;
  marketId: string;
  action: LifecycleAction;
  reason: string;
  expectedVersion: number;
}) {
  await consumeRateLimit(prisma, `admin-market-lifecycle:${input.actorUserId}`, 30, 60_000);
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const market = await tx.market.findUnique({ where: { id: input.marketId } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (market.version !== input.expectedVersion) {
      throw new ApiError(409, "STALE_MARKET_VERSION", "The market changed after this lifecycle request was prepared. Refresh and review it again.");
    }
    const rule = lifecycleRules[input.action];
    if (market.status === rule.to) return { market: publicMarket(market), replayed: true };
    if (!rule.from.includes(market.status)) {
      throw new ApiError(409, "INVALID_MARKET_TRANSITION", `Cannot ${input.action.toLowerCase()} a ${market.status} market.`);
    }
    if (input.action === "RESUME" && market.closesAt <= operationAt) {
      throw new ApiError(422, "MARKET_ALREADY_CLOSED", "A market past its close time cannot resume.");
    }
    const changed = await tx.market.updateMany({
      where: { id: market.id, status: market.status, version: market.version },
      data: {
        status: rule.to,
        acceptingOrders: input.action === "RESUME",
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed concurrently.");
    const drain = input.action === "PAUSE" || input.action === "CLOSE"
      ? await drainMarketOrderBook(tx, {
          marketId: market.id,
          actorUserId: input.actorUserId,
          reason: input.action === "PAUSE" ? "MARKET_PAUSED" : "MARKET_CLOSED",
          operationAt,
        })
      : { canceledOrders: 0, canceledQuantity: 0, commandSequence: null };
    const updated = await tx.market.findUniqueOrThrow({ where: { id: market.id } });
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: `MARKET_${input.action}D`,
        entityType: "MARKET",
        entityId: market.id,
        metadata: jsonStringify({ from: market.status, to: rule.to, reason: input.reason, ...drain }),
      },
    });
    return { market: publicMarket(updated), replayed: false };
  });
}

export async function createResolutionProposal(input: {
  actorUserId: string;
  marketId: string;
  idempotencyKey: string;
  resolution: ResolutionInput;
}) {
  await consumeRateLimit(prisma, `admin-resolution-propose:${input.actorUserId}`, 10, 60_000);
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const requestHash = createHash("sha256").update(jsonStringify(input.resolution)).digest("hex");
    const previous = await tx.marketResolutionProposal.findUnique({
      where: { proposerId_idempotencyKey: { proposerId: input.actorUserId, idempotencyKey: input.idempotencyKey } },
    });
    if (previous) {
      if (previous.requestHash !== requestHash || previous.marketId !== input.marketId) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another resolution proposal.");
      }
      return { proposal: previous, replayed: true };
    }
    let market = await tx.market.findUnique({ where: { id: input.marketId } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (market.createdById === input.actorUserId) {
      throw new ApiError(403, "CREATOR_CANNOT_PROPOSE", "A market creator cannot propose its resolution.");
    }
    if (market.status === "OPEN" && market.closesAt <= operationAt) {
      market = await tx.market.update({
        where: { id: market.id },
        data: { status: "CLOSED", acceptingOrders: false, version: { increment: 1 } },
      });
      await drainMarketOrderBook(tx, { marketId: market.id, actorUserId: input.actorUserId, reason: "MARKET_CLOSED", operationAt });
      await tx.auditLog.create({ data: { actorUserId: input.actorUserId, action: "MARKET_AUTO_CLOSED", entityType: "MARKET", entityId: market.id, metadata: jsonStringify({ reason: "Contractual close time elapsed before resolution proposal." }) } });
    }
    if (market.status !== "CLOSED" || market.closesAt > operationAt || market.resolvesAt > operationAt) {
      throw new ApiError(409, "MARKET_NOT_RESOLVABLE", "The market is not yet eligible for resolution.");
    }
    const [, pending] = await Promise.all([
      assertNoResolutionTradingExposure(tx, input.actorUserId, market.id, "PROPOSER_CONFLICT"),
      tx.marketResolutionProposal.findFirst({ where: { marketId: market.id, status: "PENDING" } }),
    ]);
    if (pending) throw new ApiError(409, "PROPOSAL_PENDING", "This market already has a pending resolution proposal.");
    const proposal = await tx.marketResolutionProposal.create({
      data: { marketId: market.id, proposerId: input.actorUserId, idempotencyKey: input.idempotencyKey, requestHash, pendingKey: market.id, ...input.resolution },
    });
    await tx.auditLog.create({
      data: { actorUserId: input.actorUserId, action: "MARKET_RESOLUTION_PROPOSED", entityType: "MARKET_RESOLUTION_PROPOSAL", entityId: proposal.id, metadata: jsonStringify(input.resolution) },
    });
    return { proposal, replayed: false };
  });
}

export async function rejectResolutionProposal(input: { actorUserId: string; proposalId: string; note: string }) {
  await consumeRateLimit(prisma, `admin-resolution-review:${input.actorUserId}`, 20, 60_000);
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const proposal = await tx.marketResolutionProposal.findUnique({ where: { id: input.proposalId } });
    if (!proposal) throw new ApiError(404, "PROPOSAL_NOT_FOUND", "Resolution proposal not found.");
    if (proposal.proposerId === input.actorUserId) throw new ApiError(403, "SELF_APPROVAL_FORBIDDEN", "A proposer cannot review their own proposal.");
    if (proposal.status !== "PENDING") throw new ApiError(409, "PROPOSAL_ALREADY_REVIEWED", "This proposal has already been reviewed.");
    const updated = await tx.marketResolutionProposal.update({ where: { id: proposal.id }, data: { status: "REJECTED", pendingKey: null, approverId: input.actorUserId, reviewNote: input.note, decidedAt: operationAt } });
    await tx.auditLog.create({ data: { actorUserId: input.actorUserId, action: "MARKET_RESOLUTION_REJECTED", entityType: "MARKET_RESOLUTION_PROPOSAL", entityId: proposal.id, metadata: jsonStringify({ note: input.note }) } });
    return { proposal: updated };
  });
}

export async function approveResolutionProposal(input: { actorUserId: string; proposalId: string; idempotencyKey: string }) {
  await consumeRateLimit(prisma, `admin-market-resolve:${input.actorUserId}`, 10, 60_000);
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveAdmin(tx, input.actorUserId);
    const proposal = await tx.marketResolutionProposal.findUnique({
      where: { id: input.proposalId },
      include: { market: true, settlementRun: true },
    });
    if (!proposal) throw new ApiError(404, "PROPOSAL_NOT_FOUND", "Resolution proposal not found.");

    const approvalRequestHash = createHash("sha256")
      .update(jsonStringify({
        proposalId: proposal.id,
        marketId: proposal.marketId,
        outcome: proposal.outcome,
        reason: proposal.reason,
        evidence: proposal.evidence,
      }))
      .digest("hex");
    if (proposal.status === "APPROVED") {
      if (
        proposal.approverId !== input.actorUserId ||
        proposal.approvalIdempotencyKey !== input.idempotencyKey ||
        proposal.approvalRequestHash !== approvalRequestHash ||
        !proposal.settlementRun
      ) {
        throw new ApiError(409, "PROPOSAL_ALREADY_REVIEWED", "This proposal was already approved by another request.");
      }
      return { proposal, run: proposal.settlementRun, replayed: true };
    }
    if (proposal.status !== "PENDING") {
      throw new ApiError(409, "PROPOSAL_ALREADY_REVIEWED", "This proposal has already been reviewed.");
    }
    if (proposal.proposerId === input.actorUserId) {
      throw new ApiError(403, "SELF_APPROVAL_FORBIDDEN", "A proposer cannot approve their own proposal.");
    }
    if (proposal.market.createdById === input.actorUserId) {
      throw new ApiError(403, "CREATOR_CANNOT_RESOLVE", "A market creator cannot resolve their own market.");
    }
    if (
      proposal.market.status !== "CLOSED" ||
      proposal.market.closesAt > operationAt ||
      proposal.market.resolvesAt > operationAt
    ) {
      throw new ApiError(409, "MARKET_NOT_RESOLVABLE", "The market is not eligible for resolution approval.");
    }
    await assertNoResolutionTradingExposure(
      tx,
      input.actorUserId,
      proposal.marketId,
      "RESOLVER_CONFLICT",
    );

    const totalPositions = await tx.position.count({
      where: {
        marketId: proposal.marketId,
        OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
      },
    });
    const now = operationAt;
    const marketClaim = await tx.market.updateMany({
      where: {
        id: proposal.marketId,
        status: "CLOSED",
        version: proposal.market.version,
        settlementRun: null,
      },
      data: {
        status: "RESOLVING",
        acceptingOrders: false,
        resolution: proposal.outcome,
        version: { increment: 1 },
      },
    });
    if (marketClaim.count !== 1) {
      throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed while its outcome was being approved.");
    }
    await drainMarketOrderBook(tx, {
      marketId: proposal.marketId,
      actorUserId: input.actorUserId,
      reason: "MARKET_RESOLVING",
      operationAt,
    });
    const approved = await tx.marketResolutionProposal.updateMany({
      where: { id: proposal.id, status: "PENDING", pendingKey: proposal.marketId },
      data: {
        status: "APPROVED",
        pendingKey: null,
        approverId: input.actorUserId,
        approvalIdempotencyKey: input.idempotencyKey,
        approvalRequestHash,
        decidedAt: now,
      },
    });
    if (approved.count !== 1) {
      throw new ApiError(409, "RETRYABLE_CONFLICT", "The proposal changed while it was being approved.");
    }
    const run = await tx.marketSettlementRun.create({
      data: {
        marketId: proposal.marketId,
        proposalId: proposal.id,
        outcome: proposal.outcome,
        reason: proposal.reason,
        evidence: proposal.evidence,
        approvedById: input.actorUserId,
        approvalIdempotencyKey: input.idempotencyKey,
        approvalRequestHash,
        totalPositions,
      },
    });
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "MARKET_RESOLUTION_APPROVED",
        entityType: "MARKET_SETTLEMENT_RUN",
        entityId: run.id,
        metadata: jsonStringify({
          proposalId: proposal.id,
          marketId: proposal.marketId,
          outcome: proposal.outcome,
          totalPositions,
          approvalRequestHash,
        }),
      },
    });
    const updatedProposal = await tx.marketResolutionProposal.findUniqueOrThrow({ where: { id: proposal.id } });
    return { proposal: updatedProposal, run, replayed: false };
  });
}

export function assertAdmin(user: { role: string; status: string }): void {
  if (user.status !== "ACTIVE" || user.role !== "ADMIN") {
    throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
  }
}

export { MARKET_STATUSES };
