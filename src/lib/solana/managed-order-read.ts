import type { Prisma } from "@prisma/client";
import { address, signature, type Address } from "@solana/kit";
import { z } from "zod";

import { db, requireDatabaseStartup } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import type { ListOrdersQuery, OrderStatus } from "@/lib/order-service";
import { encodeCursor } from "@/lib/serializers";
import { canonicalChainCommandJson } from "./chain-command";
import { readGooseyEscrow } from "./escrow-read";
import { encodeManagedCancellationReference } from "./managed-cancellation-service";
import type { CanonicalBookOrder } from "./order-book-read";
import { PROGRAM_EVENT_LIMITS } from "./program-events";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

const U64_MAX = (1n << 64n) - 1n;
const EVENT_LOOKBACK = 10_000;
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= U64_MAX);
const slug = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const clientOrderId = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const options = {
  clientOrderId,
  limitPriceMilli: z.string().regex(/^[1-9][0-9]{0,5}$/),
  quantity: z.number().int().min(1).max(10_000_000),
  postOnly: z.boolean(),
  selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
};
const commandEnvelopeSchema = z.discriminatedUnion("operation", [
  z.object({ version: z.literal(1), operation: z.literal("PLACE_ORDER"), request: z.object({
    marketId: z.string().min(1).max(191), marketSlug: slug, chainMarketId: u64,
    outcome: z.enum(["YES", "NO"]), action: z.enum(["BUY", "SELL"]),
    timeInForce: z.literal("GTC"), cancelOnPause: z.literal(true), reduceOnly: z.literal(false),
    ...options,
  }).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("REPLACE_ORDER"), request: z.object({
    marketId: z.string().min(1).max(191), marketSlug: slug, chainMarketId: u64,
    orderId: u64, expectedVersion: z.number().int().nonnegative(), cancelOnPause: z.literal(true).optional(),
    ...options,
  }).strict() }).strict(),
]);
const eventPayloadSchema = z.object({
  kind: z.literal("OrderExecuted"), market: z.string(), wallet: z.string(), orderId: u64,
  nonce: u64, filled: u64, canceled: u64, rested: u64, disposition: u64,
  outcome: u64, action: u64, price: u64,
}).strict();

const eventSelect = {
  eventKey: true, logIndex: true, invocationDepth: true, payload: true, schemaVersion: true,
  marketAddress: true, walletAddress: true,
  receipt: { select: { genesisHash: true, programAddress: true, signature: true, slot: true,
    status: true, decoderVersion: true } },
} as const satisfies Prisma.SolanaProgramEventSelect;
type EventRow = Prisma.SolanaProgramEventGetPayload<{ select: typeof eventSelect }>;

type CommandMetadata = Readonly<{
  transactionSignature: string;
  operation: "PLACE_ORDER" | "REPLACE_ORDER";
  requestJson: string;
  acceptedAt: Date;
  updatedAt: Date;
}>;

function unavailable(): never {
  throw new ApiError(503, "CHAIN_ORDER_READ_UNAVAILABLE", "Managed orders are temporarily unavailable.");
}

function decodeEvent(row: EventRow, runtime: SolanaRuntime, market: Address, wallet: Address) {
  if (row.schemaVersion !== 1 || row.marketAddress !== market || row.walletAddress !== wallet
    || row.receipt.genesisHash !== runtime.genesisHash || row.receipt.programAddress !== runtime.programAddress
    || row.receipt.status !== "VERIFIED_SUCCESS" || row.receipt.decoderVersion !== 1
    || !Number.isInteger(row.logIndex) || row.logIndex < 0 || row.logIndex >= PROGRAM_EVENT_LIMITS.logs
    || !Number.isInteger(row.invocationDepth) || row.invocationDepth < 1
    || row.invocationDepth > PROGRAM_EVENT_LIMITS.depth || typeof row.receipt.slot !== "bigint"
    || row.receipt.slot < 0n) unavailable();
  const transactionSignature = signature(row.receipt.signature);
  if (row.eventKey !== `${runtime.genesisHash}:${runtime.programAddress}:${transactionSignature}:${row.logIndex}`) unavailable();
  let raw: unknown;
  try { raw = JSON.parse(row.payload); } catch { unavailable(); }
  const payload = eventPayloadSchema.safeParse(raw);
  if (!payload.success || JSON.stringify(Object.fromEntries(Object.entries(payload.data)
    .sort(([left], [right]) => left.localeCompare(right)))) !== row.payload
    || address(payload.data.market) !== market || address(payload.data.wallet) !== wallet
    || BigInt(payload.data.outcome) > 1n || BigInt(payload.data.action) > 1n
    || BigInt(payload.data.disposition) > 7n) unavailable();
  return { ...payload.data, transactionSignature };
}

function cumulativeFee(notional: bigint, feeBps: number) {
  const numerator = notional * BigInt(feeBps);
  return numerator / 10_000n + (numerator % 10_000n === 0n ? 0n : 1n);
}

function expiry(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) unavailable();
  return BigInt(milliseconds / 1_000);
}

function isoExpiry(value: bigint | null): Date | null {
  if (value === null || value > BigInt(Math.floor(8.64e15 / 1_000))) unavailable();
  const result = new Date(Number(value) * 1_000);
  if (!Number.isFinite(result.getTime())) unavailable();
  return result;
}

export function projectManagedSolanaOrder(input: Readonly<{
  order: CanonicalBookOrder;
  bookRevision: bigint;
  feeBps: number;
  market: { id: string; slug: string; title: string; payoutMilli: bigint; chainMarketId: string };
  event: ReturnType<typeof decodeEvent>;
  command: CommandMetadata;
}>) {
  let rawEnvelope: unknown;
  try { rawEnvelope = JSON.parse(input.command.requestJson); } catch { unavailable(); }
  const envelope = commandEnvelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success || canonicalChainCommandJson(rawEnvelope) !== input.command.requestJson
    || envelope.data.operation !== input.command.operation
    || input.command.transactionSignature !== input.event.transactionSignature
    || !(input.command.acceptedAt instanceof Date) || !Number.isFinite(input.command.acceptedAt.getTime())
    || !(input.command.updatedAt instanceof Date) || !Number.isFinite(input.command.updatedAt.getTime())
    || !Number.isInteger(input.feeBps) || input.feeBps < 0 || input.feeBps > 10_000) unavailable();
  const request = envelope.data.request;
  const event = input.event, order = input.order;
  const expectedOutcome = BigInt(event.outcome) === 0n ? "YES" : "NO";
  const expectedAction = BigInt(event.action) === 0n ? "BUY" : "SELL";
  const quantity = BigInt(request.quantity);
  if (request.marketId !== input.market.id || request.marketSlug !== input.market.slug
    || request.chainMarketId !== input.market.chainMarketId || BigInt(event.orderId) !== order.id
    || BigInt(event.price) !== order.limitPrice || expectedOutcome !== order.outcome
    || expectedAction !== order.action || BigInt(event.filled) + BigInt(event.canceled) + BigInt(event.rested) !== quantity
    || BigInt(event.rested) === 0n || BigInt(event.canceled) !== 0n || order.remaining > BigInt(event.rested)
    || BigInt(request.limitPriceMilli) !== order.limitPrice || expiry(request.expiresAt) !== order.expiresAt) unavailable();
  if (envelope.data.operation === "PLACE_ORDER"
    && (envelope.data.request.outcome !== order.outcome || envelope.data.request.action !== order.action)) unavailable();
  if (input.bookRevision > BigInt(Number.MAX_SAFE_INTEGER)) unavailable();
  const initialQuantity = request.quantity;
  const remainingQuantity = Number(order.remaining);
  const filledQuantity = initialQuantity - remainingQuantity;
  const reference = encodeManagedCancellationReference({ marketSlug: input.market.slug, orderId: order.id.toString() });
  return {
    orderId: reference,
    clientOrderId: request.clientOrderId,
    market: { slug: input.market.slug, title: input.market.title, payoutMilli: input.market.payoutMilli },
    outcome: order.outcome,
    action: order.action,
    bookSide: order.side === "BID" ? "BUY" as const : "SELL" as const,
    limitPriceMilli: order.canonicalYesPrice,
    initialQuantity,
    remainingQuantity,
    filledQuantity,
    canceledQuantity: 0,
    status: filledQuantity === 0 ? "OPEN" as const : "PARTIALLY_FILLED" as const,
    timeInForce: "GTC" as const,
    postOnly: request.postOnly,
    selfTradePrevention: request.selfTradePrevention,
    cumulativeFeeMilli: cumulativeFee(order.chainNotional, input.feeBps),
    acceptedSequence: order.id,
    prioritySequence: order.sequence,
    version: Number(input.bookRevision),
    expiresAt: isoExpiry(order.expiresAt),
    terminalReason: null,
    terminalAt: null,
    createdAt: input.command.acceptedAt,
    updatedAt: input.command.updatedAt,
  };
}

type Dependencies = Readonly<{
  env?: Record<string, string | undefined>;
  read?: typeof readGooseyEscrow;
}>;

/** Exact-market bridge into the ordinary order API. Database-backed markets
 * return null so their existing SQL pagination remains untouched. Solana rows
 * are emitted only when finalized book ownership, indexed execution metadata,
 * and the originating managed command all agree.
 */
export async function listManagedSolanaOrders(input: Readonly<{
  userId: string;
  marketSlug: string;
  statuses?: OrderStatus[];
  limit: number;
  cursor?: ListOrdersQuery["cursor"];
  signal?: AbortSignal;
}>, dependencies: Dependencies = {}) {
  await requireDatabaseStartup();
  const market = await db.market.findUnique({ where: { slug: input.marketSlug }, select: {
    id: true, slug: true, title: true, payoutMilli: true, executionBackend: true, collateralAccountId: true,
    solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true,
      marketAddress: true, chainMarketId: true } },
  } });
  if (!market || market.executionBackend !== "SOLANA") return null;
  const runtime = resolveSolanaRuntime(dependencies.env ?? process.env);
  const binding = market.solanaBinding;
  if (market.collateralAccountId !== null || !binding || binding.cluster !== runtime.cluster
    || binding.genesisHash !== runtime.genesisHash || binding.programAddress !== runtime.programAddress) unavailable();
  let marketAddress: Address;
  try { marketAddress = address(binding.marketAddress); if (!u64.safeParse(binding.chainMarketId).success) unavailable(); }
  catch { unavailable(); }
  const identity = await db.solanaCustodyIdentity.findUnique({ where: { userId_chainId_genesisHash: {
    userId: input.userId, chainId: `solana:${runtime.cluster}`, genesisHash: runtime.genesisHash,
  } }, select: { walletAddress: true } });
  if (!identity) return { orders: [], nextCursor: null };
  let wallet: Address;
  try {
    wallet = address(identity.walletAddress);
    if (wallet === "11111111111111111111111111111111") unavailable();
  } catch { unavailable(); }
  const requested = new Set(input.statuses ?? ["OPEN", "PARTIALLY_FILLED"]);
  if (!requested.has("OPEN") && !requested.has("PARTIALLY_FILLED")) return { orders: [], nextCursor: null };
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(15_000)]);
  const snapshot = await (dependencies.read ?? readGooseyEscrow)(runtime,
    { marketId: BigInt(binding.chainMarketId), wallet }, { signal, includeOrderBook: true });
  if (snapshot.market !== marketAddress || snapshot.wallet !== wallet || !snapshot.orderBook?.reservesReconciled) unavailable();
  const owned = snapshot.orderBook.orders.filter(order => order.wallet === wallet);
  if (!owned.length) return { orders: [], nextCursor: null };
  const rows = await db.solanaProgramEvent.findMany({ where: {
    kind: "OrderExecuted", schemaVersion: 1, marketAddress, walletAddress: wallet,
    receipt: { is: { genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
      status: "VERIFIED_SUCCESS", decoderVersion: 1 } },
  }, orderBy: [{ receipt: { slot: "desc" } }, { receipt: { signature: "desc" } }, { logIndex: "desc" }],
  take: EVENT_LOOKBACK + 1, select: eventSelect });
  const wanted = new Set(owned.map(order => order.id.toString()));
  const events = new Map<string, ReturnType<typeof decodeEvent>>();
  for (const row of rows.slice(0, EVENT_LOOKBACK)) {
    const decoded = decodeEvent(row, runtime, marketAddress, wallet);
    if (wanted.has(decoded.orderId) && !events.has(decoded.orderId)) events.set(decoded.orderId, decoded);
  }
  if (events.size !== wanted.size) unavailable();
  const signatures = [...events.values()].map(event => event.transactionSignature);
  const wires = await db.chainCommandSignedWire.findMany({ where: {
    transactionSignature: { in: signatures },
    command: { actorId: input.userId, scope: "USER", scopeId: input.userId,
      operation: { in: ["PLACE_ORDER", "REPLACE_ORDER"] }, cluster: runtime.cluster,
      genesisHash: runtime.genesisHash, programAddress: runtime.programAddress },
  }, select: { transactionSignature: true, command: { select: { operation: true, requestJson: true,
    acceptedAt: true, updatedAt: true } } } });
  const commands = new Map<string, CommandMetadata>();
  for (const wire of wires) {
    if (wire.command.operation !== "PLACE_ORDER" && wire.command.operation !== "REPLACE_ORDER") unavailable();
    commands.set(wire.transactionSignature, { transactionSignature: wire.transactionSignature,
      operation: wire.command.operation, requestJson: wire.command.requestJson,
      acceptedAt: wire.command.acceptedAt, updatedAt: wire.command.updatedAt });
  }
  const projected = owned.map(order => {
    const event = events.get(order.id.toString());
    const command = event ? commands.get(event.transactionSignature) : undefined;
    if (!event || !command) unavailable();
    return projectManagedSolanaOrder({ order, bookRevision: snapshot.orderBook!.revision,
      feeBps: snapshot.orderBook!.feeBps, market: { id: market.id, slug: market.slug,
        title: market.title, payoutMilli: market.payoutMilli, chainMarketId: binding.chainMarketId }, event, command });
  }).filter(order => requested.has(order.status)).sort((left, right) => {
    const time = right.createdAt.getTime() - left.createdAt.getTime();
    return time || (left.orderId < right.orderId ? 1 : left.orderId > right.orderId ? -1 : 0);
  });
  const afterCursor = input.cursor ? projected.filter(order => order.createdAt < input.cursor!.createdAt
    || (order.createdAt.getTime() === input.cursor!.createdAt.getTime() && order.orderId < input.cursor!.id)) : projected;
  const page = afterCursor.slice(0, input.limit), hasMore = afterCursor.length > input.limit, last = page.at(-1);
  return { orders: page, nextCursor: hasMore && last
    ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.orderId }) : null };
}
