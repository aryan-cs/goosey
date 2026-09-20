import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { createMarketSchema } from "@/lib/admin-service";
import { ApiError, consumeRateLimit, prisma } from "@/lib/market-service";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import type { PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { deriveGooseyMarketAddresses } from "@/lib/solana/escrow-client";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const managedMarketProvisioningEnvelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("PROVISION_MARKET"),
  request: z.object({
    provisioningVersion: z.literal(1),
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
    marketAddress: z.string().min(32).max(64),
    payoutMilli: z.string().regex(/^[1-9][0-9]{0,18}$/),
    feeBps: z.number().int().min(0).max(1_000),
    closesAt: z.string().datetime(),
    resolvesAt: z.string().datetime(),
    requestedVisibility: z.enum(["DRAFT", "OPEN"]),
  }).strict(),
}).strict();

type MarketInput = z.infer<typeof createMarketSchema>;
type Tx = Prisma.TransactionClient;

type Dependencies = Readonly<{
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  rateLimit?: typeof consumeRateLimit;
}>;

function publicCommand(row: {
  id: string; operation: string; status: string; revision: number; attemptCount: number;
  acceptedAt: Date; preparedAt: Date | null; signedAt: Date | null; submittedAt: Date | null;
  confirmedAt: Date | null; finalizedAt: Date | null; projectedAt: Date | null;
  unknownSince: Date | null; updatedAt: Date;
}): PublicChainCommandStatus {
  return {
    id: row.id,
    operation: row.operation,
    status: row.status as PublicChainCommandStatus["status"],
    revision: row.revision,
    attemptCount: row.attemptCount,
    acceptedAt: row.acceptedAt,
    preparedAt: row.preparedAt,
    signedAt: row.signedAt,
    submittedAt: row.submittedAt,
    confirmedAt: row.confirmedAt,
    finalizedAt: row.finalizedAt,
    projectedAt: row.projectedAt,
    unknownSince: row.unknownSince,
    updatedAt: row.updatedAt,
  };
}

async function activeAdmin(tx: Tx, actorUserId: string): Promise<void> {
  const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: { role: true, status: true } });
  if (actor?.role !== "ADMIN" || actor.status !== "ACTIVE") {
    throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
  }
}

function chainMarketIdFor(marketId: string): bigint {
  const digest = createHash("sha256").update("goosey:chain-market-id:v1\0").update(marketId).digest();
  return digest.readBigUInt64LE(0);
}

async function resultFor(tx: Tx, marketId: string, commandId: string, replayed: boolean) {
  const [market, command] = await Promise.all([
    tx.market.findUnique({ where: { id: marketId }, include: { solanaBinding: true } }),
    tx.chainCommand.findUnique({ where: { id: commandId } }),
  ]);
  if (!market || market.executionBackend !== "SOLANA" || market.collateralAccountId !== null
    || !market.solanaBinding || !command || command.operation !== "PROVISION_MARKET") {
    throw new Error("Idempotent Solana market provisioning record is incomplete");
  }
  return Object.freeze({
    accepted: true as const,
    pending: !["PROJECTED", "FAILED_TERMINAL"].includes(command.status),
    replayed,
    subsidyMilli: 0n,
    market: {
      id: market.id,
      slug: market.slug,
      status: market.status,
      pricingModel: market.pricingModel,
      resolution: market.resolution,
      version: market.version,
      closesAt: market.closesAt,
      resolvesAt: market.resolvesAt,
      resolvedAt: market.resolvedAt,
      executionBackend: market.executionBackend,
    },
    binding: {
      cluster: market.solanaBinding.cluster,
      genesisHash: market.solanaBinding.genesisHash,
      programAddress: market.solanaBinding.programAddress,
      marketAddress: market.solanaBinding.marketAddress,
      chainMarketId: market.solanaBinding.chainMarketId,
    },
    command: publicCommand(command),
  });
}

/**
 * Atomically accepts editorial metadata as a hidden SOLANA catalog draft and a
 * durable provisioning intent. It creates no collateral account, journal entry,
 * price history, position, or other database financial authority.
 */
export async function acceptManagedMarketProvisioning(input: Readonly<{
  actorUserId: string;
  idempotencyKey: string;
  market: MarketInput;
}>, dependencies: Dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  if (input.market.pricingModel !== "ORDER_BOOK") {
    throw new ApiError(422, "CHAIN_ORDER_BOOK_REQUIRED", "New markets must use the Solana order-book engine.");
  }
  await (dependencies.rateLimit ?? consumeRateLimit)(
    prisma,
    `admin-market-create:${input.actorUserId}`,
    10,
    60_000,
  );
  const database = dependencies.database ?? prisma;
  const route = "/api/admin/markets";
  const normalized = {
    ...input.market,
    pricingModel: input.market.pricingModel,
    closesAt: new Date(Math.trunc(input.market.closesAt.getTime() / 1_000) * 1_000),
    resolvesAt: new Date(Math.trunc(input.market.resolvesAt.getTime() / 1_000) * 1_000),
  };
  const requestHash = createHash("sha256").update(jsonStringify({
    market: normalized,
    deployment: { cluster: runtime.cluster, genesisHash: runtime.genesisHash, programAddress: runtime.programAddress },
  })).digest("hex");

  return runSerializableTransaction(database, async tx => {
    await activeAdmin(tx, input.actorUserId);
    const existing = await tx.idempotencyRequest.findUnique({
      where: { userId_route_key: { userId: input.actorUserId, route, key: input.idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another market request.");
      }
      if (existing.status !== "COMPLETED" || !existing.responseBody) {
        throw new ApiError(409, "REQUEST_IN_PROGRESS", "This market request is already being processed.");
      }
      const stored = z.object({ marketId: z.string().min(1), commandId: z.string().min(1) })
        .strict().parse(JSON.parse(existing.responseBody));
      return resultFor(tx, stored.marketId, stored.commandId, true);
    }

    if (normalized.eventId) {
      const eventExists = await tx.marketEvent.count({ where: { id: normalized.eventId } });
      if (!eventExists) throw new ApiError(404, "EVENT_NOT_FOUND", "The selected event does not exist.");
    }
    await tx.idempotencyRequest.create({
      data: {
        userId: input.actorUserId,
        route,
        key: input.idempotencyKey,
        requestHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
    });

    const { eventId, status: requestedVisibility, pricingModel: _pricingModel, ...editorial } = normalized;
    void _pricingModel;
    const market = await tx.market.create({
      data: {
        ...editorial,
        pricingModel: "ORDER_BOOK",
        status: "DRAFT",
        acceptingOrders: false,
        executionBackend: "SOLANA",
        collateralAccountId: null,
        eventId: eventId ?? null,
        createdById: input.actorUserId,
      },
    });
    const chainMarketId = chainMarketIdFor(market.id);
    const addresses = await deriveGooseyMarketAddresses({
      programAddress: runtime.programAddress,
      marketId: chainMarketId,
    });
    await tx.solanaMarketBinding.create({
      data: {
        marketId: market.id,
        cluster: runtime.cluster,
        genesisHash: runtime.genesisHash,
        programAddress: runtime.programAddress,
        marketAddress: addresses.market,
        chainMarketId: chainMarketId.toString(),
      },
    });
    const commandIdentity = acceptChainCommand({
      runtime,
      scope: "MARKET",
      scopeId: market.id,
      actorId: input.actorUserId,
      operation: "PROVISION_MARKET",
      idempotencyKey: "managed-market:v1",
      request: {
        provisioningVersion: 1,
        marketId: market.id,
        marketSlug: market.slug,
        chainMarketId: chainMarketId.toString(),
        marketAddress: addresses.market,
        payoutMilli: market.payoutMilli.toString(),
        feeBps: market.feeBps,
        closesAt: market.closesAt.toISOString(),
        resolvesAt: market.resolvesAt.toISOString(),
        requestedVisibility,
      },
    });
    const command = await tx.chainCommand.create({ data: commandIdentity });
    await tx.auditLog.create({
      data: {
        actorUserId: input.actorUserId,
        action: "SOLANA_MARKET_PROVISIONING_ACCEPTED",
        entityType: "MARKET",
        entityId: market.id,
        metadata: jsonStringify({
          chainMarketId,
          marketAddress: addresses.market,
          requestedVisibility,
          requestedPricingModel: input.market.pricingModel,
          financialLedgerCreated: false,
          commandId: command.id,
        }),
      },
    });
    await tx.idempotencyRequest.update({
      where: { userId_route_key: { userId: input.actorUserId, route, key: input.idempotencyKey } },
      data: {
        status: "COMPLETED",
        responseCode: 202,
        responseBody: JSON.stringify({ marketId: market.id, commandId: command.id }),
      },
    });
    return resultFor(tx, market.id, command.id, false);
  });
}
