import { Prisma } from "@prisma/client";
import { z } from "zod";

import { ApiError, prisma } from "@/lib/market-service";
import { decodeCursor, encodeCursor } from "@/lib/serializers";

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

type FillCursor = { createdAt: Date; id: string };
export type FillRole = "MAKER" | "TAKER";

export type ListFillsQuery = {
  marketSlug?: string;
  role?: FillRole;
  limit: number;
  cursor?: FillCursor;
};

function invalidQuery(message: string): never {
  throw new ApiError(400, "INVALID_REQUEST", message);
}

export function parseListFillsQuery(searchParams: URLSearchParams): ListFillsQuery {
  const input: Record<string, string> = {};
  for (const [key, value] of searchParams) {
    if (!['marketSlug', 'role', 'limit', 'cursor'].includes(key)) {
      invalidQuery("The query contains an unknown parameter.");
    }
    if (key in input) invalidQuery("The query contains a repeated parameter.");
    input[key] = value;
  }

  const parsed = z.object({
    marketSlug: z.string().min(1).max(160).optional(),
    role: z.enum(["MAKER", "TAKER"]).optional(),
    limit: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().min(1).max(200)).default(50),
    cursor: z.string().trim().min(1).max(500).optional(),
  }).strict().parse(input);

  let cursor: FillCursor | undefined;
  if (parsed.cursor) {
    const decoded = cursorSchema.safeParse(decodeCursor(parsed.cursor));
    if (!decoded.success) throw new ApiError(400, "INVALID_CURSOR", "The fill cursor is invalid.");
    cursor = { createdAt: new Date(decoded.data.createdAt), id: decoded.data.id };
  }
  return {
    limit: parsed.limit,
    ...(parsed.marketSlug ? { marketSlug: parsed.marketSlug } : {}),
    ...(parsed.role ? { role: parsed.role } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

const privateFillSelect = {
  id: true,
  canonicalYesPriceMilli: true,
  quantity: true,
  makerFeeMilli: true,
  takerFeeMilli: true,
  matchType: true,
  tradeSequence: true,
  createdAt: true,
  market: { select: { slug: true, title: true, payoutMilli: true } },
  makerOrder: { select: { id: true, userId: true, clientOrderId: true, outcome: true, action: true } },
  takerOrder: { select: { id: true, userId: true, clientOrderId: true, outcome: true, action: true } },
} satisfies Prisma.OrderFillSelect;

type PrivateFillRow = Prisma.OrderFillGetPayload<{ select: typeof privateFillSelect }>;

export function serializePrivateFill(fill: PrivateFillRow, userId: string) {
  const maker = fill.makerOrder.userId === userId;
  const order = maker ? fill.makerOrder : fill.takerOrder;
  if (order.userId !== userId) throw new Error("Fill does not belong to the requested user.");
  return {
    fillId: fill.id,
    role: maker ? "MAKER" : "TAKER",
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    market: fill.market,
    outcome: order.outcome,
    action: order.action,
    canonicalYesPriceMilli: fill.canonicalYesPriceMilli,
    executionPriceMilli: order.outcome === "YES"
      ? fill.canonicalYesPriceMilli
      : fill.market.payoutMilli - fill.canonicalYesPriceMilli,
    quantity: fill.quantity,
    feeMilli: maker ? fill.makerFeeMilli : fill.takerFeeMilli,
    matchType: fill.matchType,
    tradeSequence: fill.tradeSequence,
    createdAt: fill.createdAt,
  };
}

export async function listUserFills(input: { userId: string } & ListFillsQuery) {
  const ownership = input.role === "MAKER"
    ? { makerOrder: { userId: input.userId } }
    : input.role === "TAKER"
      ? { takerOrder: { userId: input.userId } }
      : { OR: [{ makerOrder: { userId: input.userId } }, { takerOrder: { userId: input.userId } }] };
  const rows = await prisma.orderFill.findMany({
    where: {
      ...ownership,
      ...(input.marketSlug ? { market: { slug: input.marketSlug } } : {}),
      ...(input.cursor ? {
        AND: [{ OR: [
          { createdAt: { lt: input.cursor.createdAt } },
          { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
        ] }],
      } : {}),
    },
    take: input.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: privateFillSelect,
  });
  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);
  return {
    fills: page.map((fill) => serializePrivateFill(fill, input.userId)),
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
      : null,
  };
}
