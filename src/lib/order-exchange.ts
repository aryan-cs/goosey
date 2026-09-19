import { createHash, randomUUID } from "node:crypto";

import { Prisma, type MarketOrder, type OrderReservation, type Position, type PrismaClient } from "@prisma/client";
import { z } from "zod";

import { requiresEmailVerification } from "@/lib/auth";
import { ApiError, consumeRateLimit, prisma } from "@/lib/market-service";
import {
  calculateOrderReservation,
  cumulativeFeeMilli,
  cumulativeFeeDeltaMilli,
  planFillJournal,
  type FillEconomicKind,
  type OrderIntent,
} from "@/lib/order-book-accounting";
import {
  matchOrder,
  normalizeToYesBook,
  ORDER_BOOK_LIMITS,
  type IncomingOrder,
  type RestingOrder,
} from "@/lib/order-book";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

const canonicalMilliSchema = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, "Must be a positive canonical integer string.")
  .transform((value) => BigInt(value));
const identifierSchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Must contain only URL-safe identifier characters.");
const dateSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value));

export const placeOrderRequestSchema = z
  .object({
    marketId: identifierSchema,
    clientOrderId: identifierSchema,
    outcome: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    limitPriceMilli: canonicalMilliSchema,
    quantity: z.number().int().min(1).max(ORDER_BOOK_LIMITS.maxQuantity),
    timeInForce: z.enum(["GTC", "IOC", "FOK"]).default("GTC"),
    postOnly: z.boolean().default(false),
    selfTradePrevention: z
      .enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"])
      .default("CANCEL_AGGRESSOR"),
    expiresAt: dateSchema.nullish(),
    cancelOnPause: z.boolean().default(true),
    reduceOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.postOnly && value.timeInForce !== "GTC") {
      context.addIssue({ code: "custom", path: ["postOnly"], message: "Post-only orders must use GTC." });
    }
    if (value.expiresAt && value.timeInForce !== "GTC") {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "Only GTC orders may expire." });
    }
    if (value.reduceOnly) {
      context.addIssue({ code: "custom", path: ["reduceOnly"], message: "Reduce-only orders are not supported yet." });
    }
  });

export const cancelOrderRequestSchema = z
  .object({ orderId: identifierSchema, expectedVersion: z.number().int().nonnegative().optional() })
  .strict();

export const cancelAllOrdersRequestSchema = z
  .object({ marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional() })
  .strict();

export const replaceOrderRequestSchema = z
  .object({
    orderId: identifierSchema,
    expectedVersion: z.number().int().nonnegative(),
    clientOrderId: identifierSchema,
    limitPriceMilli: canonicalMilliSchema,
    quantity: z.number().int().min(1).max(ORDER_BOOK_LIMITS.maxQuantity),
    postOnly: z.boolean().optional(),
    selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]).optional(),
    expiresAt: dateSchema.nullish(),
    cancelOnPause: z.boolean().optional(),
  })
  .strict();

const serviceEnvelopeSchema = z
  .object({ userId: identifierSchema, idempotencyKey: identifierSchema })
  .strict();

type Tx = Prisma.TransactionClient;
type StoredOrder = MarketOrder & { reservation: OrderReservation | null };

const ACTIVE_ORDER_STATUSES = ["OPEN", "PARTIALLY_FILLED"] as const;
const EXPIRATION_BATCH_SIZE = 100;
function requestHash(value: unknown): string {
  return createHash("sha256").update(jsonStringify(value)).digest("hex");
}

function parseStoredResponse(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function orderResponse(order: Pick<MarketOrder,
  "id" | "clientOrderId" | "marketId" | "outcome" | "action" | "bookSide" |
  "limitPriceMilli" | "originalQuantity" | "remainingQuantity" | "filledQuantity" |
  "canceledQuantity" | "status" | "timeInForce" | "postOnly" | "version" |
  "acceptedSequence" | "prioritySequence" | "expiresAt" | "createdAt" | "updatedAt"
>) {
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    marketId: order.marketId,
    outcome: order.outcome,
    action: order.action,
    bookSide: order.bookSide,
    limitPriceMilli: order.limitPriceMilli,
    originalQuantity: order.originalQuantity,
    remainingQuantity: order.remainingQuantity,
    filledQuantity: order.filledQuantity,
    canceledQuantity: order.canceledQuantity,
    status: order.status,
    timeInForce: order.timeInForce,
    postOnly: order.postOnly,
    version: order.version,
    acceptedSequence: order.acceptedSequence,
    prioritySequence: order.prioritySequence,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

async function replayCommand(
  tx: Tx,
  actorUserId: string,
  scope: string,
  idempotencyKey: string,
  hash: string,
): Promise<unknown | undefined> {
  const existing = await tx.orderCommand.findUnique({
    where: { actorUserId_scope_idempotencyKey: { actorUserId, scope, idempotencyKey } },
  });
  if (!existing) return undefined;
  if (existing.requestHash !== hash) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different order command.");
  }
  if (existing.status === "COMPLETED" && existing.responseBody) {
    return parseStoredResponse(existing.responseBody);
  }
  throw new ApiError(409, "REQUEST_IN_PROGRESS", "This order command is already being processed.");
}

async function preflightCommandReplay(
  actorUserId: string,
  scope: string,
  idempotencyKey: string,
  hash: string,
): Promise<unknown | undefined> {
  const existing = await prisma.orderCommand.findUnique({
    where: { actorUserId_scope_idempotencyKey: { actorUserId, scope, idempotencyKey } },
  });
  if (!existing) return undefined;
  if (existing.requestHash !== hash) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different order command.");
  }
  if (existing.status === "COMPLETED" && existing.responseBody) {
    return parseStoredResponse(existing.responseBody);
  }
  throw new ApiError(409, "REQUEST_IN_PROGRESS", "This order command is already being processed.");
}

async function requireParticipantAndMarket(tx: Tx, userId: string, marketId: string, operationAt: Date) {
  const [user, market] = await Promise.all([
    tx.user.findUnique({ where: { id: userId } }),
    tx.market.findUnique({ where: { id: marketId }, include: { collateralAccount: true } }),
  ]);
  if (!user || user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
  }
  if (user.role !== "USER") {
    throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot trade.");
  }
  if (requiresEmailVerification(user)) {
    throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before trading.");
  }
  if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  if (market.pricingModel !== "ORDER_BOOK") {
    throw new ApiError(422, "ORDER_BOOK_UNAVAILABLE", "This market does not use the order-book engine.");
  }
  if (market.status !== "OPEN" || !market.acceptingOrders || market.closesAt <= operationAt) {
    throw new ApiError(422, "MARKET_NOT_OPEN", "This market is not open for orders.");
  }
  return { user, market };
}

async function acquireCommandSequence(
  tx: Tx,
  marketId: string,
  expected: bigint,
  requireOpen = true,
  operationAt = new Date(),
): Promise<bigint> {
  const changed = await tx.market.updateMany({
    where: {
      id: marketId,
      commandSequence: expected,
      pricingModel: "ORDER_BOOK",
      ...(requireOpen
        ? { status: "OPEN", acceptingOrders: true, closesAt: { gt: operationAt } }
        : {}),
    },
    data: { commandSequence: { increment: 1n } },
  });
  if (changed.count !== 1) {
    throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed while sequencing this command.");
  }
  return expected + 1n;
}

async function ensureWallet(tx: Tx, userId: string, cachedBalance: bigint) {
  const account = await tx.ledgerAccount.upsert({
    where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: userId, purpose: "USER_FEATHERS" } },
    create: { ownerType: "USER", ownerId: userId, purpose: "USER_FEATHERS", balanceMilli: cachedBalance },
    update: {},
  });
  if (account.balanceMilli !== cachedBalance) {
    throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "The wallet requires reconciliation.");
  }
  return account;
}

async function ensureRevenueAccount(tx: Tx) {
  return tx.ledgerAccount.upsert({
    where: { ownerType_ownerId_purpose: { ownerType: "SYSTEM", ownerId: "GOOSEY", purpose: "PROTOCOL_REVENUE" } },
    create: { ownerType: "SYSTEM", ownerId: "GOOSEY", purpose: "PROTOCOL_REVENUE" },
    update: {},
  });
}

async function mutateAccount(tx: Tx, accountId: string, delta: bigint): Promise<void> {
  if (delta === 0n) return;
  const result = await tx.ledgerAccount.updateMany({
    where: {
      id: accountId,
      status: "ACTIVE",
      ...(delta < 0n ? { balanceMilli: { gte: -delta } } : {}),
    },
    data: { balanceMilli: delta > 0n ? { increment: delta } : { decrement: -delta } },
  });
  if (result.count !== 1) {
    throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "An order account could not be updated safely.");
  }
}

async function mutateAvailableUserCash(tx: Tx, userId: string, delta: bigint): Promise<void> {
  if (delta === 0n) return;
  const result = await tx.user.updateMany({
    where: {
      id: userId,
      ...(delta < 0n ? { status: "ACTIVE", balanceMilli: { gte: -delta } } : {}),
    },
    data: { balanceMilli: delta > 0n ? { increment: delta } : { decrement: -delta } },
  });
  if (result.count !== 1) {
    throw new ApiError(422, "INSUFFICIENT_BALANCE", "You do not have enough available feathers.");
  }
}

/**
 * Atomically removes every live order from a market and releases its backing.
 * Lifecycle callers use one market command sequence and deterministic effect
 * ordering so a pause/close cannot leave hidden escrow or reserved contracts.
 */
export async function drainMarketOrderBook(
  tx: Tx,
  input: {
    marketId: string;
    actorUserId: string;
    reason: "MARKET_PAUSED" | "MARKET_CLOSED" | "MARKET_RESOLVING";
    operationAt?: Date;
  },
): Promise<{ canceledOrders: number; canceledQuantity: number; commandSequence: bigint | null }> {
  const { marketId, actorUserId, reason } = input;
  const market = await tx.market.findUnique({ where: { id: marketId } });
  if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  if (market.pricingModel !== "ORDER_BOOK") {
    return { canceledOrders: 0, canceledQuantity: 0, commandSequence: null };
  }
  const orders = await tx.marketOrder.findMany({
    where: {
      marketId,
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      remainingQuantity: { gt: 0 },
    },
    include: { reservation: true },
    orderBy: [{ prioritySequence: "asc" }, { id: "asc" }],
  });
  if (orders.length === 0) {
    const [orphaned, reservedPositions] = await Promise.all([
      tx.orderReservation.count({
        where: {
          marketId,
          OR: [
            { reservedPrincipalMilli: { gt: 0n } },
            { reservedFeeMilli: { gt: 0n } },
            { reservedYesQuantity: { gt: 0 } },
            { reservedNoQuantity: { gt: 0 } },
          ],
        },
      }),
      tx.position.count({
        where: { marketId, OR: [{ reservedYesShares: { gt: 0 } }, { reservedNoShares: { gt: 0 } }] },
      }),
    ]);
    if (orphaned > 0 || reservedPositions > 0) {
      throw new ApiError(409, "ORDER_RESERVATION_ORPHANED", "Market reservations require reconciliation before lifecycle transition.");
    }
  }

  const sequence = await acquireCommandSequence(tx, market.id, market.commandSequence, false);
  let canceledQuantity = 0;
  const now = input.operationAt ?? new Date();
  await createEvent(tx, {
    marketId,
    commandSequence: sequence,
    eventSequence: market.bookSequence + 1n,
    effectIndex: 0,
    type: "MARKET_LIFECYCLE_BARRIER",
    payload: { reason },
  });
  for (const [effectIndex, order] of orders.entries()) {
    if (!order.reservation) throw new ApiError(409, "ORDER_RESERVATION_MISSING", "A live order has no backing reservation.");
    await releaseReservation(tx, order, order.reservation, reason);
    const changed = await tx.marketOrder.updateMany({
      where: {
        id: order.id,
        version: order.version,
        remainingQuantity: order.remainingQuantity,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
      },
      data: {
        canceledQuantity: { increment: order.remainingQuantity },
        remainingQuantity: 0,
        status: "CANCELED",
        terminalSequence: sequence,
        terminalReason: reason,
        terminalAt: now,
        canceledAt: now,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "An order changed during market lifecycle cancellation.");
    canceledQuantity += order.remainingQuantity;
    await createEvent(tx, {
      marketId,
      userId: order.userId,
      commandSequence: sequence,
      eventSequence: market.bookSequence + BigInt(effectIndex + 2),
      effectIndex: effectIndex + 1,
      type: "ORDER_CANCELED",
      visibility: "PRIVATE",
      payload: { orderId: order.id, canceledQuantity: order.remainingQuantity, reason },
    });
  }
  await tx.market.update({
    where: { id: marketId },
    data: { bookSequence: { increment: BigInt(orders.length + 1) } },
  });
  const [activeOrders, liveReservations, reservedPositions] = await Promise.all([
    tx.marketOrder.count({ where: { marketId, status: { in: [...ACTIVE_ORDER_STATUSES] }, remainingQuantity: { gt: 0 } } }),
    tx.orderReservation.count({
      where: {
        marketId,
        OR: [
          { reservedPrincipalMilli: { gt: 0n } },
          { reservedFeeMilli: { gt: 0n } },
          { reservedYesQuantity: { gt: 0 } },
          { reservedNoQuantity: { gt: 0 } },
        ],
      },
    }),
    tx.position.count({ where: { marketId, OR: [{ reservedYesShares: { gt: 0 } }, { reservedNoShares: { gt: 0 } }] } }),
  ]);
  if (activeOrders > 0 || liveReservations > 0 || reservedPositions > 0) {
    throw new ApiError(409, "ORDER_BOOK_DRAIN_INCOMPLETE", "The order book could not be reconciled during lifecycle transition.");
  }
  const result = { canceledOrders: orders.length, canceledQuantity, commandSequence: sequence };
  await tx.orderCommand.create({
    data: {
      marketId,
      actorUserId,
      scope: "MARKET_LIFECYCLE",
      idempotencyKey: `${reason}:${market.version}`,
      requestHash: requestHash({ marketId, reason, marketVersion: market.version }),
      commandType: "LIFECYCLE",
      commandSequence: sequence,
      status: "COMPLETED",
      responseCode: 200,
      responseBody: jsonStringify(result),
      completedAt: now,
    },
  });
  return result;
}

async function createJournal(
  tx: Tx,
  input: {
    type: string;
    referenceType: string;
    referenceId: string;
    scope: string;
    key: string;
    actorUserId: string;
    metadata: unknown;
    postings: Array<{ ledgerAccountId: string; amountMilli: bigint }>;
  },
) {
  const postings = input.postings.filter((posting) => posting.amountMilli !== 0n);
  if (postings.length < 2 || postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n) {
    throw new Error("Order exchange attempted to create an unbalanced journal.");
  }
  for (const posting of postings) await mutateAccount(tx, posting.ledgerAccountId, posting.amountMilli);
  return tx.journalEntry.create({
    data: {
      type: input.type,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      idempotencyScope: input.scope,
      idempotencyKey: input.key,
      actorUserId: input.actorUserId,
      metadata: jsonStringify(input.metadata),
      postings: { create: postings },
    },
  });
}

async function reserveAssets(
  tx: Tx,
  order: MarketOrder,
  userBalanceMilli: bigint,
  payoutMilli: bigint,
  feeBps: number,
  previousExecutedNotionalMilli = 0n,
): Promise<OrderReservation> {
  const basePlan = calculateOrderReservation({
    outcome: order.outcome as "YES" | "NO",
    action: order.action as "BUY" | "SELL",
    limitPriceMilli: order.outcome === "YES" ? order.limitPriceMilli : payoutMilli - order.limitPriceMilli,
    quantity: BigInt(order.remainingQuantity),
    payoutMilli,
    makerFeeBps: BigInt(feeBps),
    takerFeeBps: BigInt(feeBps),
    postOnly: order.postOnly,
  });
  const maximumFeeMilli = order.action === "BUY"
    ? cumulativeFeeMilli(previousExecutedNotionalMilli + basePlan.principalMilli, basePlan.worstCaseFeeBps) -
      cumulativeFeeMilli(previousExecutedNotionalMilli, basePlan.worstCaseFeeBps)
    : basePlan.maximumFeeMilli;
  const plan = {
    ...basePlan,
    maximumFeeMilli,
    cashReserveMilli: order.action === "BUY" ? basePlan.principalMilli + maximumFeeMilli : 0n,
  };
  if (plan.cashReserveMilli > 0n) {
    const wallet = await ensureWallet(tx, order.userId, userBalanceMilli);
    const reserveAccount = await tx.ledgerAccount.create({
      data: { ownerType: "ORDER", ownerId: order.id, purpose: "ORDER_RESERVE" },
    });
    await mutateAvailableUserCash(tx, order.userId, -plan.cashReserveMilli);
    const journal = await createJournal(tx, {
      type: "ORDER_RESERVE",
      referenceType: "ORDER",
      referenceId: order.id,
      scope: `order:${order.id}:reserve`,
      key: "initial",
      actorUserId: order.userId,
      metadata: { marketId: order.marketId, principalMilli: plan.principalMilli, feeMilli: plan.maximumFeeMilli },
      postings: [
        { ledgerAccountId: wallet.id, amountMilli: -plan.cashReserveMilli },
        { ledgerAccountId: reserveAccount.id, amountMilli: plan.cashReserveMilli },
      ],
    });
    await tx.marketOrder.update({
      where: { id: order.id },
      data: {
        reservedCashMilli: plan.cashReserveMilli,
        reservedFeeMilli: plan.maximumFeeMilli,
        reservedShares: 0,
      },
    });
    return tx.orderReservation.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        marketId: order.marketId,
        cashAccountId: reserveAccount.id,
        reserveJournalId: journal.id,
        reservedPrincipalMilli: plan.principalMilli,
        reservedFeeMilli: plan.maximumFeeMilli,
      },
    });
  }

  const position = await tx.position.findUnique({
    where: { userId_marketId: { userId: order.userId, marketId: order.marketId } },
  });
  const outcome = order.outcome as "YES" | "NO";
  const shares = outcome === "YES" ? position?.yesShares ?? 0 : position?.noShares ?? 0;
  const reserved = outcome === "YES" ? position?.reservedYesShares ?? 0 : position?.reservedNoShares ?? 0;
  if (!position || shares - reserved < order.remainingQuantity) {
    throw new ApiError(422, "INSUFFICIENT_POSITION", "You do not own enough available contracts to sell.");
  }
  const changed = await tx.position.updateMany({
    where: {
      id: position.id,
      yesShares: position.yesShares,
      noShares: position.noShares,
      reservedYesShares: position.reservedYesShares,
      reservedNoShares: position.reservedNoShares,
    },
    data: outcome === "YES"
      ? { reservedYesShares: { increment: order.remainingQuantity } }
      : { reservedNoShares: { increment: order.remainingQuantity } },
  });
  if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The position changed while reserving shares.");
  await tx.marketOrder.update({
    where: { id: order.id },
    data: {
      reservedCashMilli: 0n,
      reservedFeeMilli: 0n,
      reservedShares: order.remainingQuantity,
    },
  });
  return tx.orderReservation.create({
    data: {
      orderId: order.id,
      userId: order.userId,
      marketId: order.marketId,
      reservedYesQuantity: outcome === "YES" ? order.remainingQuantity : 0,
      reservedNoQuantity: outcome === "NO" ? order.remainingQuantity : 0,
    },
  });
}

async function releaseReservation(
  tx: Tx,
  order: MarketOrder,
  reservation: OrderReservation,
  reason: string,
): Promise<void> {
  const cash = reservation.reservedPrincipalMilli + reservation.reservedFeeMilli;
  if (cash > 0n) {
    if (!reservation.cashAccountId) throw new Error("Cash reservation has no escrow account.");
    const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId } });
    const wallet = await ensureWallet(tx, order.userId, user.balanceMilli);
    await mutateAvailableUserCash(tx, order.userId, cash);
    const journal = await createJournal(tx, {
      type: "ORDER_RELEASE",
      referenceType: "ORDER",
      referenceId: order.id,
      scope: `order:${order.id}:release`,
      key: reason,
      actorUserId: order.userId,
      metadata: { marketId: order.marketId, reason },
      postings: [
        { ledgerAccountId: reservation.cashAccountId, amountMilli: -cash },
        { ledgerAccountId: wallet.id, amountMilli: cash },
      ],
    });
    await tx.orderReservation.update({
      where: { orderId: order.id },
      data: { reservedPrincipalMilli: 0n, reservedFeeMilli: 0n, releaseJournalId: journal.id, version: { increment: 1 } },
    });
    await tx.marketOrder.update({
      where: { id: order.id },
      data: { reservedCashMilli: 0n, reservedFeeMilli: 0n, reservedShares: 0 },
    });
  } else {
    const yes = reservation.reservedYesQuantity;
    const no = reservation.reservedNoQuantity;
    if (yes > 0 || no > 0) {
      const changed = await tx.position.updateMany({
        where: {
          userId: order.userId,
          marketId: order.marketId,
          reservedYesShares: { gte: yes },
          reservedNoShares: { gte: no },
        },
        data: {
          reservedYesShares: { decrement: yes },
          reservedNoShares: { decrement: no },
        },
      });
      if (changed.count !== 1) throw new Error("Share reservation is inconsistent with the position.");
    }
    await tx.orderReservation.update({
      where: { orderId: order.id },
      data: { reservedYesQuantity: 0, reservedNoQuantity: 0, version: { increment: 1 } },
    });
    await tx.marketOrder.update({
      where: { id: order.id },
      data: { reservedCashMilli: 0n, reservedFeeMilli: 0n, reservedShares: 0 },
    });
  }
}

function basisRemoved(position: Position, outcome: "YES" | "NO", quantity: number): bigint {
  const shares = outcome === "YES" ? position.yesShares : position.noShares;
  const basis = outcome === "YES" ? position.yesCostBasisMilli : position.noCostBasisMilli;
  if (quantity === shares) return basis;
  const units = BigInt(quantity);
  const shareCount = BigInt(shares);
  const basePerShare = basis / shareCount;
  const remainder = basis % shareCount;
  return basePerShare * units + (units < remainder ? units : remainder);
}

async function applyPositionLeg(
  tx: Tx,
  input: {
    userId: string;
    marketId: string;
    intent: OrderIntent;
    quantity: number;
    principalMilli: bigint;
    feeMilli: bigint;
  },
): Promise<void> {
  const existing = await tx.position.findUnique({
    where: { userId_marketId: { userId: input.userId, marketId: input.marketId } },
  });
  const yes = input.intent.outcome === "YES";
  if (input.intent.action === "BUY") {
    const cost = input.principalMilli + input.feeMilli;
    await tx.position.upsert({
      where: { userId_marketId: { userId: input.userId, marketId: input.marketId } },
      create: {
        userId: input.userId,
        marketId: input.marketId,
        yesShares: yes ? input.quantity : 0,
        noShares: yes ? 0 : input.quantity,
        netCostMilli: cost,
        yesCostBasisMilli: yes ? cost : 0n,
        noCostBasisMilli: yes ? 0n : cost,
      },
      update: {
        yesShares: { increment: yes ? input.quantity : 0 },
        noShares: { increment: yes ? 0 : input.quantity },
        netCostMilli: { increment: cost },
        yesCostBasisMilli: { increment: yes ? cost : 0n },
        noCostBasisMilli: { increment: yes ? 0n : cost },
      },
    });
    return;
  }
  if (!existing) throw new Error("Seller position disappeared while filling.");
  const shares = yes ? existing.yesShares : existing.noShares;
  const reserved = yes ? existing.reservedYesShares : existing.reservedNoShares;
  if (shares < input.quantity || reserved < input.quantity) throw new Error("Seller position is under-reserved.");
  const removed = basisRemoved(existing, input.intent.outcome, input.quantity);
  const netProceeds = input.principalMilli - input.feeMilli;
  const changed = await tx.position.updateMany({
    where: {
      id: existing.id,
      yesShares: existing.yesShares,
      noShares: existing.noShares,
      reservedYesShares: existing.reservedYesShares,
      reservedNoShares: existing.reservedNoShares,
    },
    data: {
      yesShares: { decrement: yes ? input.quantity : 0 },
      noShares: { decrement: yes ? 0 : input.quantity },
      reservedYesShares: { decrement: yes ? input.quantity : 0 },
      reservedNoShares: { decrement: yes ? 0 : input.quantity },
      netCostMilli: { decrement: removed },
      yesCostBasisMilli: { decrement: yes ? removed : 0n },
      noCostBasisMilli: { decrement: yes ? 0n : removed },
      realizedPnlMilli: { increment: netProceeds - removed },
    },
  });
  if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The seller position changed while filling.");
  await tx.user.update({
    where: { id: input.userId },
    data: { realizedPnlMilli: { increment: netProceeds - removed } },
  });
}

async function existingExecutedNotional(tx: Tx, order: MarketOrder, payoutMilli: bigint): Promise<bigint> {
  const fills = await tx.orderFill.findMany({
    where: {
      OR: [
        { makerOrder: { orderChainId: order.orderChainId } },
        { takerOrder: { orderChainId: order.orderChainId } },
      ],
    },
    select: { canonicalYesPriceMilli: true, quantity: true },
  });
  return fills.reduce((sum, fill) => {
    const price = order.outcome === "YES" ? fill.canonicalYesPriceMilli : payoutMilli - fill.canonicalYesPriceMilli;
    return sum + price * BigInt(fill.quantity);
  }, 0n);
}

async function adjustReservationAfterFill(
  tx: Tx,
  order: MarketOrder,
  reservation: OrderReservation,
  remainingQuantity: number,
  consumedPrincipal: bigint,
  consumedFee: bigint,
  executedNotionalAfter: bigint,
  payoutMilli: bigint,
  feeBps: number,
): Promise<OrderReservation> {
  if (order.action === "SELL") {
    const updated = await tx.orderReservation.update({
      where: { orderId: order.id },
      data: {
        reservedYesQuantity: order.outcome === "YES" ? remainingQuantity : 0,
        reservedNoQuantity: order.outcome === "NO" ? remainingQuantity : 0,
        version: { increment: 1 },
      },
    });
    await tx.marketOrder.update({
      where: { id: order.id },
      data: { reservedCashMilli: 0n, reservedFeeMilli: 0n, reservedShares: remainingQuantity },
    });
    return updated;
  }
  if (!reservation.cashAccountId) throw new Error("Buy order has no reserve account.");
  const userLimitPrice = order.outcome === "YES" ? order.limitPriceMilli : payoutMilli - order.limitPriceMilli;
  const required = remainingQuantity === 0
    ? { principalMilli: 0n, maximumFeeMilli: 0n }
    : {
      principalMilli: userLimitPrice * BigInt(remainingQuantity),
      maximumFeeMilli:
        cumulativeFeeMilli(
          executedNotionalAfter + userLimitPrice * BigInt(remainingQuantity),
          BigInt(feeBps),
        ) - cumulativeFeeMilli(executedNotionalAfter, BigInt(feeBps)),
    };
  const afterConsumption = reservation.reservedPrincipalMilli + reservation.reservedFeeMilli - consumedPrincipal - consumedFee;
  const requiredTotal = required.principalMilli + required.maximumFeeMilli;
  const release = afterConsumption - requiredTotal;
  if (release < 0n) throw new Error("Order reserve did not cover a fill.");
  let releaseJournalId = reservation.releaseJournalId;
  if (release > 0n) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: order.userId } });
    const wallet = await ensureWallet(tx, order.userId, user.balanceMilli);
    await mutateAvailableUserCash(tx, order.userId, release);
    const journal = await createJournal(tx, {
      type: "ORDER_PRICE_IMPROVEMENT",
      referenceType: "ORDER",
      referenceId: order.id,
      scope: `order:${order.id}:release`,
      key: `fill-${order.filledQuantity + (order.remainingQuantity - remainingQuantity)}`,
      actorUserId: order.userId,
      metadata: { reason: "PRICE_OR_FEE_IMPROVEMENT" },
      postings: [
        { ledgerAccountId: reservation.cashAccountId, amountMilli: -release },
        { ledgerAccountId: wallet.id, amountMilli: release },
      ],
    });
    releaseJournalId = journal.id;
  }
  const updated = await tx.orderReservation.update({
    where: { orderId: order.id },
    data: {
      reservedPrincipalMilli: required.principalMilli,
      reservedFeeMilli: required.maximumFeeMilli,
      releaseJournalId,
      version: { increment: 1 },
    },
  });
  await tx.marketOrder.update({
    where: { id: order.id },
    data: {
      reservedCashMilli: requiredTotal,
      reservedFeeMilli: required.maximumFeeMilli,
      reservedShares: 0,
    },
  });
  return updated;
}

async function applyFill(
  tx: Tx,
  input: {
    market: Awaited<ReturnType<typeof requireParticipantAndMarket>>["market"];
    maker: StoredOrder;
    taker: StoredOrder;
    quantity: number;
    canonicalYesPriceMilli: bigint;
    commandSequence: bigint;
    tradeSequence: bigint;
    effectIndex: number;
    fillId: string;
    executedAt: Date;
  },
): Promise<{ maker: StoredOrder; taker: StoredOrder; kind: FillEconomicKind; fillId: string }> {
  if (!input.maker.reservation || !input.taker.reservation) throw new Error("Matched order has no reservation.");
  const makerIntent = { outcome: input.maker.outcome, action: input.maker.action } as OrderIntent;
  const takerIntent = { outcome: input.taker.outcome, action: input.taker.action } as OrderIntent;
  const yesPrincipal = input.canonicalYesPriceMilli * BigInt(input.quantity);
  const noPrincipal = (input.market.payoutMilli - input.canonicalYesPriceMilli) * BigInt(input.quantity);
  const principal = (order: MarketOrder) => order.outcome === "YES" ? yesPrincipal : noPrincipal;
  const [makerPrior, takerPrior] = await Promise.all([
    existingExecutedNotional(tx, input.maker, input.market.payoutMilli),
    existingExecutedNotional(tx, input.taker, input.market.payoutMilli),
  ]);
  const makerFee = cumulativeFeeDeltaMilli({
    previousExecutedNotionalMilli: makerPrior,
    fillNotionalMilli: principal(input.maker),
    feeBps: BigInt(input.market.feeBps),
  });
  const takerFee = cumulativeFeeDeltaMilli({
    previousExecutedNotionalMilli: takerPrior,
    fillNotionalMilli: principal(input.taker),
    feeBps: BigInt(input.market.feeBps),
  });
  const plan = planFillJournal({
    maker: makerIntent,
    taker: takerIntent,
    canonicalYesPriceMilli: input.canonicalYesPriceMilli,
    quantity: BigInt(input.quantity),
    payoutMilli: input.market.payoutMilli,
    makerFeeMilli: makerFee,
    takerFeeMilli: takerFee,
  });

  const makerUser = await tx.user.findUniqueOrThrow({ where: { id: input.maker.userId } });
  const takerUser = await tx.user.findUniqueOrThrow({ where: { id: input.taker.userId } });
  const makerWallet = await ensureWallet(tx, makerUser.id, makerUser.balanceMilli);
  const takerWallet = await ensureWallet(tx, takerUser.id, takerUser.balanceMilli);
  const revenue = makerFee + takerFee > 0n ? await ensureRevenueAccount(tx) : null;
  const accountFor = (owner: "MAKER" | "TAKER" | "MARKET" | "PROTOCOL", bucket: string) => {
    if (owner === "MARKET") return input.market.collateralAccountId;
    if (owner === "PROTOCOL") {
      if (!revenue) throw new Error("Fee plan requires a revenue account.");
      return revenue.id;
    }
    const order = owner === "MAKER" ? input.maker : input.taker;
    const wallet = owner === "MAKER" ? makerWallet : takerWallet;
    if (bucket === "AVAILABLE_CASH") return wallet.id;
    if (!order.reservation?.cashAccountId) throw new Error("Fill requires a cash reservation account.");
    return order.reservation.cashAccountId;
  };
  const fillId = input.fillId;
  const postings = plan.postings.map((posting) => ({
    ledgerAccountId: accountFor(posting.owner, posting.bucket),
    amountMilli: posting.amountMilli,
  }));
  const journal = await createJournal(tx, {
    type: `ORDER_FILL_${plan.economicKind}`,
    referenceType: "ORDER_FILL",
    referenceId: fillId,
    scope: `market:${input.market.id}:fill`,
    key: `${input.commandSequence}:${input.effectIndex}`,
    actorUserId: input.taker.userId,
    metadata: { makerOrderId: input.maker.id, takerOrderId: input.taker.id, quantity: input.quantity },
    postings,
  });
  for (const posting of plan.postings) {
    if (posting.bucket !== "AVAILABLE_CASH") continue;
    const userId = posting.owner === "MAKER" ? input.maker.userId : input.taker.userId;
    await mutateAvailableUserCash(tx, userId, posting.amountMilli);
  }

  await applyPositionLeg(tx, {
    userId: input.maker.userId,
    marketId: input.market.id,
    intent: makerIntent,
    quantity: input.quantity,
    principalMilli: principal(input.maker),
    feeMilli: makerFee,
  });
  await applyPositionLeg(tx, {
    userId: input.taker.userId,
    marketId: input.market.id,
    intent: takerIntent,
    quantity: input.quantity,
    principalMilli: principal(input.taker),
    feeMilli: takerFee,
  });

  const supplyDelta = plan.economicKind === "MINT" ? input.quantity : plan.economicKind === "BURN" ? -input.quantity : 0;
  if (supplyDelta !== 0) {
    const capacity = ORDER_BOOK_LIMITS.maxQuantity - input.quantity;
    const changed = await tx.market.updateMany({
      where: {
        id: input.market.id,
        ...(supplyDelta > 0
          ? { yesShares: { lte: capacity }, noShares: { lte: capacity } }
          : { yesShares: { gte: input.quantity }, noShares: { gte: input.quantity } }),
      },
      data: { yesShares: { increment: supplyDelta }, noShares: { increment: supplyDelta } },
    });
    if (changed.count !== 1) {
      throw new ApiError(422, "MARKET_CAPACITY_EXCEEDED", "This fill would exceed the market quantity limit.");
    }
  }

  const updateOrder = async (order: StoredOrder, fee: bigint) => {
    const remaining = order.remainingQuantity - input.quantity;
    const changed = await tx.marketOrder.updateMany({
      where: { id: order.id, version: order.version, remainingQuantity: order.remainingQuantity, status: { in: [...ACTIVE_ORDER_STATUSES] } },
      data: {
        remainingQuantity: remaining,
        filledQuantity: { increment: input.quantity },
        cumulativeFeeMilli: { increment: fee },
        status: remaining === 0 ? "FILLED" : "PARTIALLY_FILLED",
        version: { increment: 1 },
        ...(remaining === 0 ? { terminalSequence: input.commandSequence, terminalReason: "FILLED", terminalAt: input.executedAt } : {}),
      },
    });
    if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "An order changed while matching.");
    const reservation = await adjustReservationAfterFill(
      tx,
      order,
      order.reservation!,
      remaining,
      principal(order),
      fee,
      (order.id === input.maker.id ? makerPrior : takerPrior) + principal(order),
      input.market.payoutMilli,
      input.market.feeBps,
    );
    return { ...order, remainingQuantity: remaining, filledQuantity: order.filledQuantity + input.quantity, cumulativeFeeMilli: order.cumulativeFeeMilli + fee, status: remaining === 0 ? "FILLED" : "PARTIALLY_FILLED", version: order.version + 1, reservation } as StoredOrder;
  };
  const maker = await updateOrder(input.maker, makerFee);
  const taker = await updateOrder(input.taker, takerFee);
  await tx.orderFill.create({
    data: {
      id: fillId,
      marketId: input.market.id,
      makerOrderId: input.maker.id,
      takerOrderId: input.taker.id,
      canonicalYesPriceMilli: input.canonicalYesPriceMilli,
      quantity: input.quantity,
      makerFeeMilli: makerFee,
      takerFeeMilli: takerFee,
      matchType: plan.economicKind,
      commandSequence: input.commandSequence,
      tradeSequence: input.tradeSequence,
      effectIndex: input.effectIndex,
      journalEntryId: journal.id,
    },
  });
  return { maker, taker, kind: plan.economicKind, fillId };
}

async function createEvent(
  tx: Tx,
  input: { marketId: string; userId?: string; commandSequence: bigint; eventSequence: bigint; effectIndex: number; type: string; visibility?: string; payload: unknown },
) {
  return tx.orderEvent.create({
    data: {
      marketId: input.marketId,
      userId: input.userId,
      commandSequence: input.commandSequence,
      eventSequence: input.eventSequence,
      effectIndex: input.effectIndex,
      type: input.type,
      visibility: input.visibility ?? "PUBLIC",
      payload: jsonStringify(input.payload),
    },
  });
}

/**
 * Writes one history point for the authoritative final execution in a command.
 * A multi-level sweep intentionally produces no synthetic intermediate points.
 */
export async function appendAuthoritativeFillSnapshot(
  tx: Pick<Tx, "marketPriceSnapshot">,
  marketId: string,
  payoutMilli: bigint,
  fills: readonly { priceMilli: bigint }[],
  recordedAt = new Date(),
) {
  const finalFill = fills.at(-1);
  if (!finalFill) return null;
  const probability = impliedProbabilityBps(finalFill.priceMilli, payoutMilli);
  if (probability > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Final fill probability exceeds the snapshot integer range.");
  }
  return tx.marketPriceSnapshot.create({
    data: { marketId, yesProbabilityBps: Number(probability), createdAt: recordedAt },
  });
}

export type ExpireOrdersResult = {
  expired: number;
  failures: Array<{ orderId: string; error: unknown }>;
};

/**
 * Expires resting GTC orders in deterministic expiry/id order. Every expiry is
 * its own serializable market command so reservation release, terminal state,
 * and the private order event either commit together or roll back together.
 */
export async function expireOrders(
  client: PrismaClient,
  operationAt = new Date(),
  beforeEach?: () => Promise<void>,
): Promise<ExpireOrdersResult> {
  const candidates = await client.marketOrder.findMany({
    where: {
      status: { in: [...ACTIVE_ORDER_STATUSES] },
      remainingQuantity: { gt: 0 },
      expiresAt: { lte: operationAt },
    },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: EXPIRATION_BATCH_SIZE,
    select: { id: true },
  });
  let expired = 0;
  const failures: Array<{ orderId: string; error: unknown }> = [];

  for (const candidate of candidates) {
    try {
      await beforeEach?.();
      const changed = await runSerializableTransaction(client, async (tx) => {
        const order = await tx.marketOrder.findUnique({
          where: { id: candidate.id },
          include: { reservation: true, market: { include: { collateralAccount: true } } },
        });
        if (
          !order ||
          !ACTIVE_ORDER_STATUSES.includes(order.status as (typeof ACTIVE_ORDER_STATUSES)[number]) ||
          order.remainingQuantity <= 0 ||
          !order.expiresAt ||
          order.expiresAt > operationAt
        ) return false;
        if (!order.reservation) throw new Error("Live expiring order has no reservation.");

        const sequence = await acquireCommandSequence(tx, order.market.id, order.market.commandSequence, false, operationAt);
        await releaseReservation(tx, order, order.reservation, "ORDER_EXPIRED");
        const terminal = await tx.marketOrder.updateMany({
          where: {
            id: order.id,
            version: order.version,
            remainingQuantity: order.remainingQuantity,
            status: { in: [...ACTIVE_ORDER_STATUSES] },
            expiresAt: { lte: operationAt },
          },
          data: {
            canceledQuantity: { increment: order.remainingQuantity },
            remainingQuantity: 0,
            status: "CANCELED",
            terminalSequence: sequence,
            terminalReason: "ORDER_EXPIRED",
            terminalAt: operationAt,
            canceledAt: operationAt,
            version: { increment: 1 },
          },
        });
        if (terminal.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The order changed while expiring.");

        const eventSequence = order.market.bookSequence + 1n;
        await tx.market.update({ where: { id: order.market.id }, data: { bookSequence: { increment: 1n } } });
        await createEvent(tx, {
          marketId: order.market.id,
          userId: order.userId,
          commandSequence: sequence,
          eventSequence,
          effectIndex: 0,
          type: "ORDER_CANCELED",
          visibility: "PRIVATE",
          payload: { orderId: order.id, canceledQuantity: order.remainingQuantity, reason: "ORDER_EXPIRED" },
        });
        return true;
      });
      if (changed) expired += 1;
    } catch (error) {
      failures.push({ orderId: candidate.id, error });
    }
  }
  return { expired, failures };
}

/**
 * Places and synchronously matches one fully collateralized order. Existing
 * LMSR markets are rejected without touching their state.
 */
export async function placeOrder(raw: {
  userId: string;
  idempotencyKey: string;
  request: unknown;
}): Promise<unknown> {
  const envelope = serviceEnvelopeSchema.parse({ userId: raw.userId, idempotencyKey: raw.idempotencyKey });
  const request = placeOrderRequestSchema.parse(raw.request);
  const scope = "ORDER_PLACE";
  const hash = requestHash(request);
  const preflight = await preflightCommandReplay(envelope.userId, scope, envelope.idempotencyKey, hash);
  if (preflight !== undefined) return preflight;
  await consumeRateLimit(prisma, `order-place:${envelope.userId}`, 60, 60_000);
  const operationAt = new Date();
  const orderId = randomUUID();
  const fillIds: string[] = [];
  return runSerializableTransaction(prisma, async (tx) => {
    const replay = await replayCommand(tx, envelope.userId, scope, envelope.idempotencyKey, hash);
    if (replay !== undefined) return replay;
    if (request.expiresAt && request.expiresAt <= operationAt) {
      throw new ApiError(422, "INVALID_EXPIRATION", "Order expiration must be in the future.");
    }
    const { user, market } = await requireParticipantAndMarket(tx, envelope.userId, request.marketId, operationAt);
    if (request.limitPriceMilli >= market.payoutMilli) {
      throw new ApiError(422, "INVALID_PRICE", "Price must be below the market payout.");
    }
    const [userActiveOrders, marketActiveOrders] = await Promise.all([
      tx.marketOrder.count({
        where: { marketId: market.id, userId: user.id, status: { in: [...ACTIVE_ORDER_STATUSES] }, remainingQuantity: { gt: 0 } },
      }),
      tx.marketOrder.count({
        where: { marketId: market.id, status: { in: [...ACTIVE_ORDER_STATUSES] }, remainingQuantity: { gt: 0 } },
      }),
    ]);
    if (userActiveOrders >= ORDER_BOOK_LIMITS.maxActiveOrdersPerUserMarket) {
      throw new ApiError(422, "USER_OPEN_ORDER_LIMIT", "Cancel an existing order before placing another in this market.");
    }
    if (marketActiveOrders >= ORDER_BOOK_LIMITS.maxActiveOrdersPerMarket) {
      throw new ApiError(503, "MARKET_ORDER_CAPACITY", "This market has reached its active-order capacity.");
    }
    const sequence = await acquireCommandSequence(tx, market.id, market.commandSequence, true, operationAt);
    const normalized = normalizeToYesBook(request.outcome, request.action, request.limitPriceMilli, market.payoutMilli);
    const makers = await tx.marketOrder.findMany({
      where: {
        marketId: market.id,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        remainingQuantity: { gt: 0 },
        bookSide: normalized.side === "BUY" ? "SELL" : "BUY",
      },
      include: { reservation: true },
      orderBy: [
        { limitPriceMilli: normalized.side === "BUY" ? "asc" : "desc" },
        { prioritySequence: "asc" },
        { id: "asc" },
      ],
    });
    const incoming: IncomingOrder = {
      id: orderId,
      ownerId: user.id,
      stpOwnerId: user.id,
      side: normalized.side,
      limitPriceMilli: normalized.limitPriceMilli,
      remainingQuantity: request.quantity,
      prioritySequence: sequence,
      timeInForce: request.timeInForce,
      postOnly: request.postOnly,
      selfTradePrevention: request.selfTradePrevention,
    };
    const book: RestingOrder[] = makers.map((order) => ({
      id: order.id,
      ownerId: order.userId,
      stpOwnerId: order.stpOwnerId,
      side: order.bookSide as "BUY" | "SELL",
      limitPriceMilli: order.limitPriceMilli,
      remainingQuantity: order.remainingQuantity,
      prioritySequence: order.prioritySequence,
    }));
    const matched = matchOrder(book, incoming, market.payoutMilli);
    if (matched.disposition === "POST_ONLY_WOULD_TRADE" || matched.disposition === "FOK_NOT_FILLABLE") {
      const code = matched.disposition;
      const body = { accepted: false, reason: code, marketId: market.id, commandSequence: sequence };
      await tx.orderCommand.create({
        data: {
          marketId: market.id,
          actorUserId: user.id,
          scope,
          idempotencyKey: envelope.idempotencyKey,
          requestHash: hash,
          commandType: "PLACE",
          commandSequence: sequence,
          status: "COMPLETED",
          responseCode: 422,
          responseBody: jsonStringify(body),
          completedAt: operationAt,
        },
      });
      await tx.market.update({ where: { id: market.id }, data: { bookSequence: { increment: 1n } } });
      await createEvent(tx, {
        marketId: market.id,
        userId: user.id,
        commandSequence: sequence,
        eventSequence: market.bookSequence + 1n,
        effectIndex: 0,
        type: "ORDER_REJECTED",
        visibility: "PRIVATE",
        payload: body,
      });
      return parseStoredResponse(jsonStringify(body));
    }

    let taker = await tx.marketOrder.create({
      data: {
        id: orderId,
        userId: user.id,
        marketId: market.id,
        clientOrderId: request.clientOrderId,
        outcome: request.outcome,
        action: request.action,
        bookSide: normalized.side,
        limitPriceMilli: normalized.limitPriceMilli,
        originalQuantity: request.quantity,
        remainingQuantity: request.quantity,
        status: "OPEN",
        timeInForce: request.timeInForce,
        postOnly: request.postOnly,
        stpOwnerId: user.id,
        selfTradePrevention: request.selfTradePrevention,
        acceptedSequence: sequence,
        prioritySequence: sequence,
        orderChainId: orderId,
        expiresAt: request.expiresAt ?? null,
        cancelOnPause: request.cancelOnPause,
      },
      include: { reservation: true },
    }) as StoredOrder;
    taker = { ...taker, reservation: await reserveAssets(tx, taker, user.balanceMilli, market.payoutMilli, market.feeBps) };
    const makerMap = new Map(makers.map((maker) => [maker.id, maker as StoredOrder]));
    let eventIndex = 0;
    let tradeSequence = market.tradeSequence;
    for (const fill of matched.fills) {
      const maker = makerMap.get(fill.makerOrderId);
      if (!maker) throw new Error("Matcher selected an unknown maker.");
      tradeSequence += 1n;
      const applied = await applyFill(tx, {
        market,
        maker,
        taker,
        quantity: fill.quantity,
        canonicalYesPriceMilli: fill.priceMilli,
        commandSequence: sequence,
        tradeSequence,
        effectIndex: eventIndex,
        fillId: fillIds[eventIndex] ?? (fillIds[eventIndex] = randomUUID()),
        executedAt: operationAt,
      });
      makerMap.set(maker.id, applied.maker);
      taker = applied.taker;
      eventIndex += 1;
      await createEvent(tx, {
        marketId: market.id,
        commandSequence: sequence,
        eventSequence: market.bookSequence + BigInt(eventIndex),
        effectIndex: eventIndex - 1,
        type: "ORDER_FILL",
        payload: { fillId: applied.fillId, makerOrderId: maker.id, takerOrderId: taker.id, quantity: fill.quantity, canonicalYesPriceMilli: fill.priceMilli, matchType: applied.kind },
      });
    }

    const makerIdsToCancel = request.selfTradePrevention === "CANCEL_AGGRESSOR"
      ? []
      : matched.preventedOrderIds;
    for (const makerId of makerIdsToCancel) {
      const maker = makerMap.get(makerId);
      if (!maker || !maker.reservation || maker.remainingQuantity === 0) continue;
      await releaseReservation(tx, maker, maker.reservation, "SELF_TRADE_PREVENTION");
      await tx.marketOrder.update({
        where: { id: maker.id },
        data: { canceledQuantity: { increment: maker.remainingQuantity }, remainingQuantity: 0, status: "CANCELED", terminalSequence: sequence, terminalReason: "SELF_TRADE_PREVENTION", terminalAt: operationAt, canceledAt: operationAt, version: { increment: 1 } },
      });
      eventIndex += 1;
      await createEvent(tx, {
        marketId: market.id,
        userId: maker.userId,
        commandSequence: sequence,
        eventSequence: market.bookSequence + BigInt(eventIndex),
        effectIndex: eventIndex - 1,
        type: "ORDER_CANCELED",
        visibility: "PRIVATE",
        payload: { orderId: maker.id, reason: "SELF_TRADE_PREVENTION" },
      });
    }

    const terminalRemainder = matched.canceledQuantity;
    if (terminalRemainder > 0) {
      const currentReservation = await tx.orderReservation.findUniqueOrThrow({ where: { orderId: taker.id } });
      const currentOrder = await tx.marketOrder.findUniqueOrThrow({ where: { id: taker.id } });
      await releaseReservation(tx, currentOrder, currentReservation, matched.disposition);
      taker = await tx.marketOrder.update({
        where: { id: taker.id },
        data: {
          canceledQuantity: { increment: terminalRemainder },
          remainingQuantity: 0,
          status: "CANCELED",
          terminalSequence: sequence,
          terminalReason: matched.disposition,
          terminalAt: operationAt,
          canceledAt: operationAt,
          version: { increment: 1 },
        },
        include: { reservation: true },
      }) as StoredOrder;
    }
    eventIndex += 1;
    await createEvent(tx, {
      marketId: market.id,
      userId: user.id,
      commandSequence: sequence,
      eventSequence: market.bookSequence + BigInt(eventIndex),
      effectIndex: eventIndex - 1,
      type: "ORDER_STATE",
      visibility: "PRIVATE",
      payload: orderResponse(taker),
    });
    await tx.market.update({
      where: { id: market.id },
      data: {
        bookSequence: { increment: BigInt(eventIndex) },
        tradeSequence,
        volumeMilli: { increment: matched.fills.reduce((sum, fill) => sum + market.payoutMilli * BigInt(fill.quantity), 0n) },
      },
    });
    await appendAuthoritativeFillSnapshot(tx, market.id, market.payoutMilli, matched.fills, operationAt);
    const result = { accepted: true, order: orderResponse(taker), fills: matched.fills, commandSequence: sequence };
    await tx.orderCommand.create({
      data: {
        marketId: market.id,
        actorUserId: user.id,
        orderId: taker.id,
        scope,
        idempotencyKey: envelope.idempotencyKey,
        requestHash: hash,
        commandType: "PLACE",
        commandSequence: sequence,
        status: "COMPLETED",
        responseCode: 201,
        responseBody: jsonStringify(result),
        completedAt: operationAt,
      },
    });
    return parseStoredResponse(jsonStringify(result));
  });
}

/** Cancels only an authenticated owner's live remainder and releases it once. */
export async function cancelOrder(raw: {
  userId: string;
  idempotencyKey: string;
  request: unknown;
}): Promise<unknown> {
  const envelope = serviceEnvelopeSchema.parse({ userId: raw.userId, idempotencyKey: raw.idempotencyKey });
  const request = cancelOrderRequestSchema.parse(raw.request);
  const scope = "ORDER_CANCEL";
  const hash = requestHash(request);
  const preflight = await preflightCommandReplay(envelope.userId, scope, envelope.idempotencyKey, hash);
  if (preflight !== undefined) return preflight;
  await consumeRateLimit(prisma, `order-cancel:${envelope.userId}`, 120, 60_000);
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    const replay = await replayCommand(tx, envelope.userId, scope, envelope.idempotencyKey, hash);
    if (replay !== undefined) return replay;
    const order = await tx.marketOrder.findFirst({
      where: { id: request.orderId, userId: envelope.userId },
      include: { reservation: true, market: { include: { collateralAccount: true } }, user: true },
    });
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (order.user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
    if (order.user.role !== "USER") throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot trade.");
    if (requiresEmailVerification(order.user)) throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before trading.");
    if (order.market.pricingModel !== "ORDER_BOOK") throw new ApiError(422, "ORDER_BOOK_UNAVAILABLE", "This market does not use the order-book engine.");
    if (!ACTIVE_ORDER_STATUSES.includes(order.status as (typeof ACTIVE_ORDER_STATUSES)[number]) || order.remainingQuantity <= 0) {
      throw new ApiError(409, "ORDER_NOT_RESTING", "This order has no live quantity to cancel.");
    }
    if (request.expectedVersion !== undefined && request.expectedVersion !== order.version) {
      throw new ApiError(409, "STALE_ORDER_VERSION", "The order changed before cancellation.", { currentVersion: order.version });
    }
    if (!order.reservation) throw new Error("Live order has no reservation.");
    const sequence = await acquireCommandSequence(tx, order.market.id, order.market.commandSequence, false);
    await releaseReservation(tx, order, order.reservation, "USER_CANCELED");
    const changed = await tx.marketOrder.updateMany({
      where: { id: order.id, userId: envelope.userId, version: order.version, remainingQuantity: order.remainingQuantity, status: { in: [...ACTIVE_ORDER_STATUSES] } },
      data: {
        canceledQuantity: { increment: order.remainingQuantity },
        remainingQuantity: 0,
        status: "CANCELED",
        terminalSequence: sequence,
        terminalReason: "USER_CANCELED",
        terminalAt: operationAt,
        canceledAt: operationAt,
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The order changed while canceling.");
    const updated = await tx.marketOrder.findUniqueOrThrow({ where: { id: order.id } });
    const eventSequence = order.market.bookSequence + 1n;
    await tx.market.update({ where: { id: order.market.id }, data: { bookSequence: { increment: 1n } } });
    await createEvent(tx, {
      marketId: order.market.id,
      userId: order.userId,
      commandSequence: sequence,
      eventSequence,
      effectIndex: 0,
      type: "ORDER_CANCELED",
      visibility: "PRIVATE",
      payload: { orderId: order.id, canceledQuantity: order.remainingQuantity, reason: "USER_CANCELED" },
    });
    const result = { order: orderResponse(updated), canceledQuantity: order.remainingQuantity, commandSequence: sequence };
    await tx.orderCommand.create({
      data: {
        marketId: order.market.id,
        actorUserId: order.userId,
        orderId: order.id,
        scope,
        idempotencyKey: envelope.idempotencyKey,
        requestHash: hash,
        commandType: "CANCEL",
        commandSequence: sequence,
        status: "COMPLETED",
        responseCode: 200,
        responseBody: jsonStringify(result),
        completedAt: operationAt,
      },
    });
    return parseStoredResponse(jsonStringify(result));
  });
}

/**
 * Atomically cancels every live order owned by one participant, optionally in
 * one market. The batch has its own replay record and advances each market's
 * command/event sequences without losing deterministic ordering.
 */
export async function cancelAllOrders(raw: {
  userId: string;
  idempotencyKey: string;
  request: unknown;
}): Promise<unknown> {
  const envelope = serviceEnvelopeSchema.parse({ userId: raw.userId, idempotencyKey: raw.idempotencyKey });
  const request = cancelAllOrdersRequestSchema.parse(raw.request);
  const route = "/api/v1/orders:bulk-cancel";
  const hash = requestHash(request);
  await consumeRateLimit(prisma, `order-bulk-cancel:${envelope.userId}`, 10, 60_000);
  const operationAt = new Date();

  return runSerializableTransaction(prisma, async (tx) => {
    const existing = await tx.idempotencyRequest.findUnique({
      where: { userId_route_key: { userId: envelope.userId, route, key: envelope.idempotencyKey } },
    });
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different bulk cancellation.");
      }
      if (existing.status === "COMPLETED" && existing.responseBody) {
        return parseStoredResponse(existing.responseBody);
      }
      throw new ApiError(409, "REQUEST_IN_PROGRESS", "This bulk cancellation is already being processed.");
    }

    const user = await tx.user.findUnique({ where: { id: envelope.userId } });
    if (!user || user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
    if (user.role !== "USER") throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot trade.");
    if (requiresEmailVerification(user)) throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before trading.");

    const replay = await tx.idempotencyRequest.create({
      data: {
        userId: envelope.userId,
        route,
        key: envelope.idempotencyKey,
        requestHash: hash,
        expiresAt: new Date(operationAt.getTime() + 24 * 60 * 60 * 1_000),
      },
    });
    const orders = await tx.marketOrder.findMany({
      where: {
        userId: envelope.userId,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        remainingQuantity: { gt: 0 },
        market: { pricingModel: "ORDER_BOOK", ...(request.marketSlug ? { slug: request.marketSlug } : {}) },
      },
      include: { reservation: true, market: { include: { collateralAccount: true } } },
      orderBy: [{ marketId: "asc" }, { prioritySequence: "asc" }, { id: "asc" }],
    });
    const sequenceState = new Map<string, { command: bigint; book: bigint }>();
    const canceled: Array<{ orderId: string; canceledQuantity: number; commandSequence: bigint }> = [];
    let totalCanceledQuantity = 0;

    for (const order of orders) {
      if (!order.reservation) throw new Error("Live bulk-canceled order has no reservation.");
      const state = sequenceState.get(order.marketId) ?? {
        command: order.market.commandSequence,
        book: order.market.bookSequence,
      };
      const commandSequence = await acquireCommandSequence(tx, order.marketId, state.command, false, operationAt);
      await releaseReservation(tx, order, order.reservation, "USER_BULK_CANCELED");
      const changed = await tx.marketOrder.updateMany({
        where: {
          id: order.id,
          userId: envelope.userId,
          version: order.version,
          remainingQuantity: order.remainingQuantity,
          status: { in: [...ACTIVE_ORDER_STATUSES] },
        },
        data: {
          canceledQuantity: { increment: order.remainingQuantity },
          remainingQuantity: 0,
          status: "CANCELED",
          terminalSequence: commandSequence,
          terminalReason: "USER_BULK_CANCELED",
          terminalAt: operationAt,
          canceledAt: operationAt,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "An order changed during bulk cancellation.");
      const eventSequence = state.book + 1n;
      await tx.market.update({ where: { id: order.marketId }, data: { bookSequence: { increment: 1n } } });
      await createEvent(tx, {
        marketId: order.marketId,
        userId: envelope.userId,
        commandSequence,
        eventSequence,
        effectIndex: 0,
        type: "ORDER_CANCELED",
        visibility: "PRIVATE",
        payload: { orderId: order.id, canceledQuantity: order.remainingQuantity, reason: "USER_BULK_CANCELED" },
      });
      sequenceState.set(order.marketId, { command: commandSequence, book: eventSequence });
      totalCanceledQuantity += order.remainingQuantity;
      canceled.push({ orderId: order.id, canceledQuantity: order.remainingQuantity, commandSequence });
    }

    const result = {
      canceledCount: canceled.length,
      canceledQuantity: totalCanceledQuantity,
      marketSlug: request.marketSlug ?? null,
      orders: canceled,
    };
    const responseBody = jsonStringify(result);
    await tx.idempotencyRequest.update({
      where: { id: replay.id },
      data: { status: "COMPLETED", responseCode: 200, responseBody },
    });
    return parseStoredResponse(responseBody);
  });
}

/**
 * Atomically cancels one owner's live GTC remainder and submits a new GTC
 * order in the same market command. A replacement always receives a fresh
 * priority sequence; any failure to reserve or execute the replacement rolls
 * the original cancellation back.
 */
export async function replaceOrder(raw: {
  userId: string;
  idempotencyKey: string;
  request: unknown;
}): Promise<unknown> {
  const envelope = serviceEnvelopeSchema.parse({ userId: raw.userId, idempotencyKey: raw.idempotencyKey });
  const request = replaceOrderRequestSchema.parse(raw.request);
  const scope = "ORDER_REPLACE";
  const hash = requestHash(request);
  const preflight = await preflightCommandReplay(envelope.userId, scope, envelope.idempotencyKey, hash);
  if (preflight !== undefined) return preflight;
  await consumeRateLimit(prisma, `order-replace:${envelope.userId}`, 120, 60_000);
  const operationAt = new Date();
  const replacementOrderId = randomUUID();
  const fillIds: string[] = [];

  return runSerializableTransaction(prisma, async (tx) => {
    const replay = await replayCommand(tx, envelope.userId, scope, envelope.idempotencyKey, hash);
    if (replay !== undefined) return replay;

    const original = await tx.marketOrder.findFirst({
      where: { id: request.orderId, userId: envelope.userId },
      include: { reservation: true },
    });
    if (!original) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
    if (!ACTIVE_ORDER_STATUSES.includes(original.status as (typeof ACTIVE_ORDER_STATUSES)[number]) || original.remainingQuantity <= 0) {
      throw new ApiError(409, "ORDER_NOT_RESTING", "This order has no live quantity to replace.");
    }
    if (original.timeInForce !== "GTC") {
      throw new ApiError(409, "ORDER_NOT_REPLACEABLE", "Only resting GTC orders can be replaced.");
    }
    if (request.expectedVersion !== original.version) {
      throw new ApiError(409, "STALE_ORDER_VERSION", "The order changed before replacement.", { currentVersion: original.version });
    }
    if (!original.reservation) throw new Error("Live order has no reservation.");
    if (request.expiresAt && request.expiresAt <= operationAt) {
      throw new ApiError(422, "INVALID_EXPIRATION", "Order expiration must be in the future.");
    }

    const { user, market } = await requireParticipantAndMarket(tx, envelope.userId, original.marketId, operationAt);
    if (request.limitPriceMilli >= market.payoutMilli) {
      throw new ApiError(422, "INVALID_PRICE", "Price must be below the market payout.");
    }

    const sequence = await acquireCommandSequence(tx, market.id, market.commandSequence, true, operationAt);
    const normalized = normalizeToYesBook(
      original.outcome as "YES" | "NO",
      original.action as "BUY" | "SELL",
      request.limitPriceMilli,
      market.payoutMilli,
    );
    const makers = await tx.marketOrder.findMany({
      where: {
        marketId: market.id,
        id: { not: original.id },
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        remainingQuantity: { gt: 0 },
        bookSide: normalized.side === "BUY" ? "SELL" : "BUY",
      },
      include: { reservation: true },
      orderBy: [
        { limitPriceMilli: normalized.side === "BUY" ? "asc" : "desc" },
        { prioritySequence: "asc" },
        { id: "asc" },
      ],
    });
    const replacementSettings = {
      postOnly: request.postOnly ?? original.postOnly,
      selfTradePrevention: request.selfTradePrevention ?? original.selfTradePrevention,
      expiresAt: request.expiresAt === undefined ? original.expiresAt : request.expiresAt,
      cancelOnPause: request.cancelOnPause ?? original.cancelOnPause,
    };
    const incoming: IncomingOrder = {
      id: replacementOrderId,
      ownerId: user.id,
      stpOwnerId: original.stpOwnerId,
      side: normalized.side,
      limitPriceMilli: normalized.limitPriceMilli,
      remainingQuantity: request.quantity,
      prioritySequence: sequence,
      timeInForce: "GTC",
      postOnly: replacementSettings.postOnly,
      selfTradePrevention: replacementSettings.selfTradePrevention as IncomingOrder["selfTradePrevention"],
    };
    const book: RestingOrder[] = makers.map((order) => ({
      id: order.id,
      ownerId: order.userId,
      stpOwnerId: order.stpOwnerId,
      side: order.bookSide as "BUY" | "SELL",
      limitPriceMilli: order.limitPriceMilli,
      remainingQuantity: order.remainingQuantity,
      prioritySequence: order.prioritySequence,
    }));
    const matched = matchOrder(book, incoming, market.payoutMilli);

    // A rejected post-only amendment must leave the original order untouched.
    if (matched.disposition === "POST_ONLY_WOULD_TRADE") {
      const body = {
        accepted: false,
        reason: matched.disposition,
        originalOrderId: original.id,
        marketId: market.id,
        commandSequence: sequence,
      };
      await tx.orderCommand.create({
        data: {
          marketId: market.id,
          actorUserId: user.id,
          orderId: original.id,
          scope,
          idempotencyKey: envelope.idempotencyKey,
          requestHash: hash,
          commandType: "REPLACE",
          commandSequence: sequence,
          status: "COMPLETED",
          responseCode: 422,
          responseBody: jsonStringify(body),
          completedAt: operationAt,
        },
      });
      await tx.market.update({ where: { id: market.id }, data: { bookSequence: { increment: 1n } } });
      await createEvent(tx, {
        marketId: market.id,
        userId: user.id,
        commandSequence: sequence,
        eventSequence: market.bookSequence + 1n,
        effectIndex: 0,
        type: "ORDER_REPLACE_REJECTED",
        visibility: "PRIVATE",
        payload: body,
      });
      return parseStoredResponse(jsonStringify(body));
    }

    const chainExecutedNotional = await existingExecutedNotional(tx, original, market.payoutMilli);
    await releaseReservation(tx, original, original.reservation, "ORDER_REPLACED");
    const canceled = await tx.marketOrder.updateMany({
      where: {
        id: original.id,
        userId: envelope.userId,
        version: original.version,
        remainingQuantity: original.remainingQuantity,
        status: { in: [...ACTIVE_ORDER_STATUSES] },
      },
      data: {
        canceledQuantity: { increment: original.remainingQuantity },
        remainingQuantity: 0,
        status: "CANCELED",
        terminalSequence: sequence,
        terminalReason: "ORDER_REPLACED",
        terminalAt: operationAt,
        canceledAt: operationAt,
        version: { increment: 1 },
      },
    });
    if (canceled.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The order changed while replacing.");

    let replacement = await tx.marketOrder.create({
      data: {
        id: replacementOrderId,
        userId: user.id,
        marketId: market.id,
        clientOrderId: request.clientOrderId,
        outcome: original.outcome,
        action: original.action,
        bookSide: normalized.side,
        limitPriceMilli: normalized.limitPriceMilli,
        originalQuantity: request.quantity,
        remainingQuantity: request.quantity,
        status: "OPEN",
        timeInForce: "GTC",
        postOnly: replacementSettings.postOnly,
        stpOwnerId: original.stpOwnerId,
        selfTradePrevention: replacementSettings.selfTradePrevention,
        acceptedSequence: sequence,
        prioritySequence: sequence,
        orderChainId: original.orderChainId,
        replacementVersion: original.replacementVersion + 1,
        replacedOrderId: original.id,
        expiresAt: replacementSettings.expiresAt,
        cancelOnPause: replacementSettings.cancelOnPause,
        reduceOnly: false,
      },
      include: { reservation: true },
    }) as StoredOrder;
    const currentUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    replacement = {
      ...replacement,
      reservation: await reserveAssets(
        tx,
        replacement,
        currentUser.balanceMilli,
        market.payoutMilli,
        market.feeBps,
        chainExecutedNotional,
      ),
    };

    const makerMap = new Map(makers.map((maker) => [maker.id, maker as StoredOrder]));
    let eventIndex = 1;
    let tradeSequence = market.tradeSequence;
    await createEvent(tx, {
      marketId: market.id,
      userId: user.id,
      commandSequence: sequence,
      eventSequence: market.bookSequence + 1n,
      effectIndex: 0,
      type: "ORDER_REPLACED",
      visibility: "PRIVATE",
      payload: {
        originalOrderId: original.id,
        replacementOrderId,
        canceledQuantity: original.remainingQuantity,
        replacementVersion: original.replacementVersion + 1,
      },
    });

    for (const fill of matched.fills) {
      const maker = makerMap.get(fill.makerOrderId);
      if (!maker) throw new Error("Matcher selected an unknown maker.");
      tradeSequence += 1n;
      const applied = await applyFill(tx, {
        market,
        maker,
        taker: replacement,
        quantity: fill.quantity,
        canonicalYesPriceMilli: fill.priceMilli,
        commandSequence: sequence,
        tradeSequence,
        effectIndex: eventIndex,
        fillId: fillIds[eventIndex - 1] ?? (fillIds[eventIndex - 1] = randomUUID()),
        executedAt: operationAt,
      });
      makerMap.set(maker.id, applied.maker);
      replacement = applied.taker;
      await createEvent(tx, {
        marketId: market.id,
        commandSequence: sequence,
        eventSequence: market.bookSequence + BigInt(eventIndex + 1),
        effectIndex: eventIndex,
        type: "ORDER_FILL",
        payload: {
          fillId: applied.fillId,
          makerOrderId: maker.id,
          takerOrderId: replacement.id,
          quantity: fill.quantity,
          canonicalYesPriceMilli: fill.priceMilli,
          matchType: applied.kind,
        },
      });
      eventIndex += 1;
    }

    if (replacementSettings.selfTradePrevention !== "CANCEL_AGGRESSOR") {
      for (const makerId of matched.preventedOrderIds) {
        const maker = makerMap.get(makerId);
        if (!maker || !maker.reservation || maker.remainingQuantity === 0) continue;
        await releaseReservation(tx, maker, maker.reservation, "SELF_TRADE_PREVENTION");
        await tx.marketOrder.update({
          where: { id: maker.id },
          data: {
            canceledQuantity: { increment: maker.remainingQuantity },
            remainingQuantity: 0,
            status: "CANCELED",
            terminalSequence: sequence,
            terminalReason: "SELF_TRADE_PREVENTION",
            terminalAt: operationAt,
            canceledAt: operationAt,
            version: { increment: 1 },
          },
        });
        await createEvent(tx, {
          marketId: market.id,
          userId: maker.userId,
          commandSequence: sequence,
          eventSequence: market.bookSequence + BigInt(eventIndex + 1),
          effectIndex: eventIndex,
          type: "ORDER_CANCELED",
          visibility: "PRIVATE",
          payload: { orderId: maker.id, reason: "SELF_TRADE_PREVENTION" },
        });
        eventIndex += 1;
      }
    }

    if (matched.canceledQuantity > 0) {
      const currentReservation = await tx.orderReservation.findUniqueOrThrow({ where: { orderId: replacement.id } });
      const currentOrder = await tx.marketOrder.findUniqueOrThrow({ where: { id: replacement.id } });
      await releaseReservation(tx, currentOrder, currentReservation, matched.disposition);
      replacement = await tx.marketOrder.update({
        where: { id: replacement.id },
        data: {
          canceledQuantity: { increment: matched.canceledQuantity },
          remainingQuantity: 0,
          status: "CANCELED",
          terminalSequence: sequence,
          terminalReason: matched.disposition,
          terminalAt: operationAt,
          canceledAt: operationAt,
          version: { increment: 1 },
        },
        include: { reservation: true },
      }) as StoredOrder;
    }

    await createEvent(tx, {
      marketId: market.id,
      userId: user.id,
      commandSequence: sequence,
      eventSequence: market.bookSequence + BigInt(eventIndex + 1),
      effectIndex: eventIndex,
      type: "ORDER_STATE",
      visibility: "PRIVATE",
      payload: orderResponse(replacement),
    });
    eventIndex += 1;
    await tx.market.update({
      where: { id: market.id },
      data: {
        bookSequence: { increment: BigInt(eventIndex) },
        tradeSequence,
        volumeMilli: { increment: matched.fills.reduce((sum, fill) => sum + market.payoutMilli * BigInt(fill.quantity), 0n) },
      },
    });
    await appendAuthoritativeFillSnapshot(tx, market.id, market.payoutMilli, matched.fills, operationAt);

    const result = {
      accepted: true,
      replacedOrderId: original.id,
      order: orderResponse(replacement),
      fills: matched.fills,
      commandSequence: sequence,
    };
    await tx.orderCommand.create({
      data: {
        marketId: market.id,
        actorUserId: user.id,
        orderId: replacement.id,
        scope,
        idempotencyKey: envelope.idempotencyKey,
        requestHash: hash,
        commandType: "REPLACE",
        commandSequence: sequence,
        status: "COMPLETED",
        responseCode: 200,
        responseBody: jsonStringify(result),
        completedAt: operationAt,
      },
    });
    return parseStoredResponse(jsonStringify(result));
  });
}
