import { Prisma } from "@prisma/client";
import { z } from "zod";

import { ApiError, prisma } from "@/lib/market-service";
import { decodeCursor, encodeCursor } from "@/lib/serializers";

export const ORDER_STATUSES = [
  "OPEN",
  "PARTIALLY_FILLED",
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
] as const;

export const orderStatusSchema = z.enum(ORDER_STATUSES);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

const canonicalLimitSchema = (maximum: number, fallback: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/, "Must be a canonical positive integer.")
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(maximum))
    .default(fallback);

export const listOrdersQuerySchema = z
  .object({
    marketSlug: z.string().min(1).max(160).optional(),
    status: z.array(orderStatusSchema).max(ORDER_STATUSES.length).optional(),
    limit: canonicalLimitSchema(200, 50),
    cursor: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const orderBookQuerySchema = z
  .object({ depth: canonicalLimitSchema(500, 100) })
  .strict();

function invalidQuery(message: string): never {
  throw new ApiError(400, "INVALID_REQUEST", message);
}

/** Parse an order-book query without silently collapsing duplicate keys. */
export function parseOrderBookQuery(searchParams: URLSearchParams): { depth: number } {
  const input: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (key !== "depth") invalidQuery("The query contains an unknown parameter.");
    if (key in input) invalidQuery("The query contains a repeated parameter.");
    input[key] = value;
  }
  return orderBookQuerySchema.parse(input);
}

export type ListOrdersQuery = {
  marketSlug?: string;
  statuses?: OrderStatus[];
  limit: number;
  cursor?: PrivateOrderCursor;
};

type PrivateOrderCursor = {
  createdAt: Date;
  id: string;
};

const privateOrderCursorSchema = z
  .object({
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();

function decodePrivateOrderCursor(value: string): PrivateOrderCursor {
  const decoded = decodeCursor(value);
  const parsed = privateOrderCursorSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ApiError(400, "INVALID_CURSOR", "The order cursor is invalid.");
  }
  return { createdAt: new Date(parsed.data.createdAt), id: parsed.data.id };
}

/** `status` is intentionally repeatable; every other parameter is scalar. */
export function parseListOrdersQuery(searchParams: URLSearchParams): ListOrdersQuery {
  const input: { marketSlug?: string; status?: string[]; limit?: string; cursor?: string } = {};
  const statuses: string[] = [];

  for (const [key, value] of searchParams) {
    if (key === "status") {
      if (statuses.includes(value)) invalidQuery("The query contains a repeated status value.");
      statuses.push(value);
      continue;
    }
    if (key !== "marketSlug" && key !== "limit" && key !== "cursor") {
      invalidQuery("The query contains an unknown parameter.");
    }
    if (key in input) invalidQuery("The query contains a repeated parameter.");
    input[key] = value;
  }
  if (statuses.length > 0) input.status = statuses;

  const parsed = listOrdersQuerySchema.parse(input);
  return {
    ...(parsed.marketSlug === undefined ? {} : { marketSlug: parsed.marketSlug }),
    ...(parsed.status === undefined ? {} : { statuses: parsed.status }),
    ...(parsed.cursor === undefined ? {} : { cursor: decodePrivateOrderCursor(parsed.cursor) }),
    limit: parsed.limit,
  };
}

export type PriceLevel = {
  priceMilli: bigint;
  quantity: bigint;
  orderCount: number;
};

export function aggregateOrderLevels(
  orders: ReadonlyArray<{ limitPriceMilli: bigint; remainingQuantity: number }>,
  descending: boolean,
  depth: number,
): PriceLevel[] {
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 500) {
    throw new RangeError("depth must be a safe integer between 1 and 500");
  }

  const levels = new Map<bigint, PriceLevel>();
  for (const order of orders) {
    if (!Number.isSafeInteger(order.remainingQuantity) || order.remainingQuantity <= 0) {
      throw new RangeError("remainingQuantity must be a positive safe integer");
    }
    if (typeof order.limitPriceMilli !== "bigint" || order.limitPriceMilli <= 0n) {
      throw new RangeError("limitPriceMilli must be a positive bigint");
    }
    const level = levels.get(order.limitPriceMilli);
    if (level) {
      level.quantity += BigInt(order.remainingQuantity);
      level.orderCount += 1;
      if (!Number.isSafeInteger(level.orderCount)) {
        throw new RangeError("orderCount exceeds the safe integer range");
      }
    } else {
      levels.set(order.limitPriceMilli, {
        priceMilli: order.limitPriceMilli,
        quantity: BigInt(order.remainingQuantity),
        orderCount: 1,
      });
    }
  }
  return [...levels.values()]
    .sort((left, right) => {
      if (left.priceMilli === right.priceMilli) return 0;
      const comparison = left.priceMilli < right.priceMilli ? -1 : 1;
      return descending ? -comparison : comparison;
    })
    .slice(0, depth);
}

export async function getPublicOrderBook(slug: string, depth: number) {
  return prisma.$transaction(
    async (tx) => {
      const now = new Date();
      const market = await tx.market.findUnique({
        where: { slug },
        select: {
          id: true,
          slug: true,
          status: true,
          pricingModel: true,
          payoutMilli: true,
          bookSequence: true,
          acceptingOrders: true,
          closesAt: true,
        },
      });
      if (!market || market.status === "DRAFT") {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      }
      if (market.pricingModel !== "ORDER_BOOK") {
        throw new ApiError(422, "ORDER_BOOK_UNAVAILABLE", "This market uses the legacy market maker.");
      }
      if (market.status !== "OPEN" || !market.acceptingOrders || market.closesAt <= now) {
        return { marketSlug: market.slug, marketStatus: market.status, sequence: market.bookSequence, payoutMilli: market.payoutMilli, bids: [], asks: [] };
      }

      const active = {
        marketId: market.id,
        user: { status: "ACTIVE", role: "USER" },
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      } satisfies Prisma.MarketOrderWhereInput;
      const bidRows = await tx.marketOrder.groupBy({
        by: ["limitPriceMilli"],
        where: { ...active, bookSide: "BUY" },
        _sum: { remainingQuantity: true },
        _count: { _all: true },
        orderBy: { limitPriceMilli: "desc" },
        take: depth,
      });
      const askRows = await tx.marketOrder.groupBy({
        by: ["limitPriceMilli"],
        where: { ...active, bookSide: "SELL" },
        _sum: { remainingQuantity: true },
        _count: { _all: true },
        orderBy: { limitPriceMilli: "asc" },
        take: depth,
      });
      const toLevels = (rows: typeof bidRows): PriceLevel[] => rows.map((row) => ({
        priceMilli: row.limitPriceMilli,
        quantity: BigInt(row._sum.remainingQuantity ?? 0),
        orderCount: row._count._all,
      }));
      const bids = toLevels(bidRows);
      const asks = toLevels(askRows);
      return {
        marketSlug: market.slug,
        marketStatus: market.status,
        sequence: market.bookSequence,
        payoutMilli: market.payoutMilli,
        bids,
        asks,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

const privateOrderSelect = {
  id: true,
  clientOrderId: true,
  outcome: true,
  action: true,
  bookSide: true,
  limitPriceMilli: true,
  originalQuantity: true,
  remainingQuantity: true,
  filledQuantity: true,
  canceledQuantity: true,
  status: true,
  timeInForce: true,
  postOnly: true,
  selfTradePrevention: true,
  cumulativeFeeMilli: true,
  acceptedSequence: true,
  prioritySequence: true,
  version: true,
  expiresAt: true,
  terminalReason: true,
  terminalAt: true,
  createdAt: true,
  updatedAt: true,
  market: { select: { slug: true, title: true, payoutMilli: true } },
} satisfies Prisma.MarketOrderSelect;

type PrivateOrderRow = Prisma.MarketOrderGetPayload<{ select: typeof privateOrderSelect }>;

export function serializePrivateOrder(order: PrivateOrderRow) {
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    market: order.market,
    outcome: order.outcome,
    action: order.action,
    bookSide: order.bookSide,
    limitPriceMilli: order.limitPriceMilli,
    initialQuantity: order.originalQuantity,
    remainingQuantity: order.remainingQuantity,
    filledQuantity: order.filledQuantity,
    canceledQuantity: order.canceledQuantity,
    status: order.status,
    timeInForce: order.timeInForce,
    postOnly: order.postOnly,
    selfTradePrevention: order.selfTradePrevention,
    cumulativeFeeMilli: order.cumulativeFeeMilli,
    acceptedSequence: order.acceptedSequence,
    prioritySequence: order.prioritySequence,
    version: order.version,
    expiresAt: order.expiresAt,
    terminalReason: order.terminalReason,
    terminalAt: order.terminalAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export async function listUserOrders(input: {
  userId: string;
  marketSlug?: string;
  statuses?: OrderStatus[];
  limit: number;
  cursor?: PrivateOrderCursor;
}) {
  const rows = await prisma.marketOrder.findMany({
    where: {
      userId: input.userId,
      status: { in: input.statuses ?? [...ORDER_STATUSES] },
      market: {
        pricingModel: "ORDER_BOOK",
        ...(input.marketSlug ? { slug: input.marketSlug } : {}),
      },
      ...(input.cursor
        ? {
            OR: [
              { createdAt: { lt: input.cursor.createdAt } },
              { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
            ],
          }
        : {}),
    },
    take: input.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: privateOrderSelect,
  });
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);
  return {
    orders: page.map(serializePrivateOrder),
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
