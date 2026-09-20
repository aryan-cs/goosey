import { DATABASE_MARKET_FILTER } from "./market-backend";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { ApiError } from "./market-service";
import { decodeCursor, encodeCursor } from "./serializers";

export type TradeHistorySource = "LMSR" | "ORDER_BOOK";
export type TradeHistoryCursor = { createdAt: Date; id: string };

export interface TradeHistoryItem {
  id: string;
  market: { slug: string; shortTitle: string };
  side: string;
  action: string;
  quantity: number;
  amountMilli: bigint;
  feeMilli: bigint;
  createdAt: Date;
  source: TradeHistorySource;
}

const sourcePrefix = {
  LMSR: "lmsr",
  ORDER_BOOK: "orderbook",
} as const;

const prefixedIdSchema = z.string()
  .min(6)
  .max(220)
  .regex(/^(?:lmsr|orderbook):[A-Za-z0-9._:-]{1,200}$/);

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: prefixedIdSchema,
}).strict();

function invalidCursor(): never {
  throw new ApiError(400, "INVALID_CURSOR", "The trade history cursor is invalid.");
}

function validateCursor(cursor: TradeHistoryCursor): TradeHistoryCursor {
  if (!(cursor.createdAt instanceof Date) || !Number.isFinite(cursor.createdAt.getTime())) invalidCursor();
  if (!prefixedIdSchema.safeParse(cursor.id).success) invalidCursor();
  return cursor;
}

export function parseTradeHistoryCursor(raw: string | undefined): TradeHistoryCursor | undefined {
  if (raw === undefined) return undefined;
  if (raw.length < 1 || raw.length > 512) invalidCursor();
  const decoded = cursorSchema.safeParse(decodeCursor(raw));
  if (!decoded.success) invalidCursor();
  return {
    createdAt: new Date(decoded.data.createdAt),
    id: decoded.data.id,
  };
}

export function encodeTradeHistoryCursor(cursor: TradeHistoryCursor): string {
  const valid = validateCursor(cursor);
  return encodeCursor({ createdAt: valid.createdAt.toISOString(), id: valid.id });
}

function prefixedId(source: TradeHistorySource, id: string): string {
  return `${sourcePrefix[source]}:${id}`;
}

function splitPrefixedId(id: string): { prefix: string; rawId: string } {
  const separator = id.indexOf(":");
  return { prefix: id.slice(0, separator), rawId: id.slice(separator + 1) };
}

/** Build the per-table boundary for the global (createdAt, prefixed id) key. */
function sourceBoundary(source: TradeHistorySource, cursor?: TradeHistoryCursor) {
  if (!cursor) return {};
  const valid = validateCursor(cursor);
  const { prefix: cursorPrefix, rawId } = splitPrefixedId(valid.id);
  const prefix = sourcePrefix[source];
  const branches: Array<Record<string, unknown>> = [{ createdAt: { lt: valid.createdAt } }];
  if (prefix === cursorPrefix) {
    branches.push({ createdAt: valid.createdAt, id: { lt: rawId } });
  } else if (prefix < cursorPrefix) {
    // Every id from this source sorts below the cursor at an equal timestamp.
    branches.push({ createdAt: valid.createdAt });
  }
  return { AND: [{ OR: branches }] };
}

const legacySelect = {
  id: true,
  side: true,
  action: true,
  quantity: true,
  amountMilli: true,
  feeMilli: true,
  createdAt: true,
  market: { select: { slug: true, shortTitle: true } },
} satisfies Prisma.TradeSelect;

const fillSelect = {
  id: true,
  canonicalYesPriceMilli: true,
  quantity: true,
  makerFeeMilli: true,
  takerFeeMilli: true,
  createdAt: true,
  market: { select: { slug: true, shortTitle: true, payoutMilli: true } },
  makerOrder: { select: { userId: true, outcome: true, action: true } },
  takerOrder: { select: { userId: true, outcome: true, action: true } },
} satisfies Prisma.OrderFillSelect;

type LegacyRow = Prisma.TradeGetPayload<{ select: typeof legacySelect }>;
type FillRow = Prisma.OrderFillGetPayload<{ select: typeof fillSelect }>;

function legacyItem(row: LegacyRow): TradeHistoryItem {
  return {
    id: prefixedId("LMSR", row.id),
    market: row.market,
    side: row.side,
    action: row.action,
    quantity: row.quantity,
    amountMilli: row.amountMilli,
    feeMilli: row.feeMilli,
    createdAt: row.createdAt,
    source: "LMSR",
  };
}

function fillItem(row: FillRow, userId: string): TradeHistoryItem {
  const maker = row.makerOrder.userId === userId;
  const ownOrder = maker ? row.makerOrder : row.takerOrder;
  if (ownOrder.userId !== userId) throw new Error("Order-book fill does not belong to the requested user.");
  const executionPriceMilli = ownOrder.outcome === "YES"
    ? row.canonicalYesPriceMilli
    : row.market.payoutMilli - row.canonicalYesPriceMilli;
  return {
    id: prefixedId("ORDER_BOOK", row.id),
    market: { slug: row.market.slug, shortTitle: row.market.shortTitle },
    side: ownOrder.outcome,
    action: ownOrder.action,
    quantity: row.quantity,
    amountMilli: executionPriceMilli * BigInt(row.quantity),
    feeMilli: maker ? row.makerFeeMilli : row.takerFeeMilli,
    createdAt: row.createdAt,
    source: "ORDER_BOOK",
  };
}

function newestFirst(left: TradeHistoryItem, right: TradeHistoryItem): number {
  const timestamp = right.createdAt.getTime() - left.createdAt.getTime();
  if (timestamp !== 0) return timestamp;
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}

export async function loadTradeHistory(
  tx: Prisma.TransactionClient,
  userId: string,
  input: { limit: number; cursor?: TradeHistoryCursor; marketWhere?: Prisma.MarketWhereInput },
): Promise<{ items: TradeHistoryItem[]; nextCursor: string | null }> {
  const limit = input.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, "INVALID_REQUEST", "Trade history limit must be between 1 and 100.");
  }
  const cursor = input.cursor ? validateCursor(input.cursor) : undefined;
  const [legacyRows, fillRows] = await Promise.all([
    tx.trade.findMany({
      where: { market: input.marketWhere ?? DATABASE_MARKET_FILTER, userId, ...sourceBoundary("LMSR", cursor) },
      select: legacySelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
    tx.orderFill.findMany({
      where: {
        market: input.marketWhere ?? DATABASE_MARKET_FILTER,
        OR: [{ makerOrder: { userId } }, { takerOrder: { userId } }],
        ...sourceBoundary("ORDER_BOOK", cursor),
      },
      select: fillSelect,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }),
  ]);
  const merged = [
    ...legacyRows.map(legacyItem),
    ...fillRows.map((fill) => fillItem(fill, userId)),
  ].sort(newestFirst);
  const hasMore = merged.length > limit;
  const items = hasMore ? merged.slice(0, limit) : merged;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last
      ? encodeTradeHistoryCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  };
}
