import { DATABASE_MARKET_FILTER } from "./market-backend";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { db } from "./db";
import { ApiError } from "./market-service";
import { loadMarketMarks, type LoadedMarketMark } from "./market-marks";
import { runSerializableTransaction } from "./serializable-transaction";

const timingSchema = z.enum(["all", "live", "upcoming", "past"]);
const listSchema = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  timing: timingSchema.default("all"),
  limit: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().min(1).max(50)).default(24),
  cursor: z.string().min(1).max(2048).optional(),
}).strict();
export type EventListQuery = z.infer<typeof listSchema>;

const exactDate = z.string().datetime().refine((value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
});
const cursorSchema = z.object({
  v: z.literal(1), category: z.string().min(1).max(60).nullable(), timing: timingSchema,
  asOf: exactDate, featured: z.boolean(), startsAt: exactDate, id: z.string().min(1).max(200),
}).strict();
type EventCursor = z.infer<typeof cursorSchema>;
const encodeCursor = (cursor: EventCursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

function decodeCursor(value: string, query: Pick<EventListQuery, "category" | "timing">): EventCursor {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const text = Buffer.from(value, "base64url").toString("utf8");
    const cursor = cursorSchema.parse(JSON.parse(text));
    if (encodeCursor(cursor) !== value || cursor.category !== (query.category ?? null) || cursor.timing !== query.timing) throw new Error();
    return cursor;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Invalid event cursor for these filters.");
  }
}

export function parseEventListQuery(input: Record<string, unknown>): EventListQuery {
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_QUERY", "Invalid event query parameters.");
  if (parsed.data.cursor) decodeCursor(parsed.data.cursor, parsed.data);
  return parsed.data;
}

const eventSelect = {
  id: true, slug: true, title: true, shortTitle: true, description: true,
  category: true, featured: true, color: true, icon: true,
  startsAt: true, endsAt: true, createdAt: true, updatedAt: true,
  markets: {
    where: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" } },
    orderBy: [{ featured: "desc" }, { closesAt: "asc" }, { id: "asc" }],
    select: {
      id: true, slug: true, title: true, shortTitle: true, description: true,
      executionBackend: true, collateralAccountId: true, status: true, pricingModel: true, acceptingOrders: true, resolution: true,
      closesAt: true, resolvesAt: true, yesShares: true, noShares: true,
      liquidityParameter: true, payoutMilli: true, volumeMilli: true,
      traderCount: true, commentCount: true,
    },
  },
} as const satisfies Prisma.MarketEventSelect;
type SelectedEvent = Prisma.MarketEventGetPayload<{ select: typeof eventSelect }>;
export type PublicEvent = Omit<SelectedEvent, "markets"> & {
  markets: Array<Omit<SelectedEvent["markets"][number], "collateralAccountId"> & {
    probabilityYesBps: number | null;
    probabilitySource: LoadedMarketMark["source"];
    probabilityStale: boolean;
  }>;
};

async function markedEvents(tx: Prisma.TransactionClient, events: SelectedEvent[], now: Date): Promise<PublicEvent[]> {
  const marks = await loadMarketMarks(tx, events.flatMap((event) => event.markets), now);
  return events.map((event) => ({
    ...event,
    markets: event.markets.map((market) => {
      const mark = marks.get(market.id);
      if (!mark) throw new Error("Market mark missing from batch.");
      return { ...market, collateralAccountId: undefined, probabilityYesBps: mark.probabilityYesBps, probabilitySource: mark.source, probabilityStale: mark.stale };
    }),
  }));
}

export async function listPublicEvents(database: typeof db, input: EventListQuery): Promise<{ items: PublicEvent[]; nextCursor: string | null }> {
  const query = parseEventListQuery(input);
  const cursor = query.cursor ? decodeCursor(query.cursor, query) : null;
  const now = new Date();
  // Freeze only membership timing across pages; market marks remain current.
  const asOf = cursor ? new Date(cursor.asOf) : now;
  return runSerializableTransaction(database, async (tx) => {
    const events = await tx.marketEvent.findMany({
      where: {
        ...(query.category ? { category: query.category } : {}),
        ...(query.timing === "live" ? { startsAt: { lte: asOf }, endsAt: { gt: asOf } } : {}),
        ...(query.timing === "upcoming" ? { startsAt: { gt: asOf } } : {}),
        ...(query.timing === "past" ? { endsAt: { lte: asOf } } : {}),
        markets: { some: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" } } },
        ...(cursor ? { AND: [{ OR: [
          ...(cursor.featured ? [{ featured: false }] : []),
          { featured: cursor.featured, startsAt: { gt: new Date(cursor.startsAt) } },
          { featured: cursor.featured, startsAt: new Date(cursor.startsAt), id: { gt: cursor.id } },
        ] }] } : {}),
      },
      orderBy: [{ featured: "desc" }, { startsAt: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      select: eventSelect,
    });
    const page = events.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor = events.length > query.limit && last ? encodeCursor({
      v: 1, category: query.category ?? null, timing: query.timing, asOf: asOf.toISOString(),
      featured: last.featured, startsAt: last.startsAt.toISOString(), id: last.id,
    }) : null;
    return { items: await markedEvents(tx, page, now), nextCursor };
  });
}

export async function getPublicEvent(database: typeof db, slug: string): Promise<PublicEvent | null> {
  if (typeof slug !== "string" || slug.length < 3 || slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  return runSerializableTransaction(database, async (tx) => {
    const event = await tx.marketEvent.findUnique({ where: { slug }, select: eventSelect });
    if (!event || event.markets.length === 0) return null;
    return (await markedEvents(tx, [event], new Date()))[0];
  });
}
