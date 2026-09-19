import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { db } from "./db";

const mocks = vi.hoisted(() => ({
  tx: { marketEvent: { findMany: vi.fn(), findUnique: vi.fn() } },
  transaction: vi.fn(), marks: vi.fn(),
}));
vi.mock("./market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const jsonResponse = (data: unknown, init?: ResponseInit) => NextResponse.json(
    JSON.parse(JSON.stringify(data, (_key, value) => typeof value === "bigint" ? String(value) : value)), init,
  );
  return {
    ApiError, prisma: { $transaction: mocks.transaction }, jsonResponse,
    apiErrorResponse: (error: unknown) => jsonResponse({ error: "Invalid request" }, { status: error instanceof ApiError ? error.status : 400 }),
  };
});
vi.mock("./market-marks", () => ({ loadMarketMarks: mocks.marks }));

import { getPublicEvent, listPublicEvents, parseEventListQuery } from "./public-events";
import { GET as listGet } from "../app/api/events/route";
import { GET as detailGet } from "../app/api/events/[slug]/route";

const database = { $transaction: mocks.transaction } as unknown as typeof db;
const instant = new Date("2026-09-19T12:00:00.000Z");
function event(id = "event-one", featured = true) {
  return {
    id, slug: id, title: id, shortTitle: id, description: "Campus event", category: "Campus",
    featured, color: "gold", icon: "goose", startsAt: instant, endsAt: new Date("2026-09-20T12:00:00.000Z"),
    createdAt: instant, updatedAt: instant,
    markets: [{
      id: `${id}-market`, slug: `${id}-market`, title: "A forecast", shortTitle: "Forecast", description: "A contract",
      status: "OPEN", pricingModel: "ORDER_BOOK", acceptingOrders: true, resolution: null,
      closesAt: new Date("2026-09-20T12:00:00.000Z"), resolvesAt: new Date("2026-09-21T12:00:00.000Z"),
      yesShares: 0, noShares: 0, liquidityParameter: 100, payoutMilli: 100_000n,
      volumeMilli: 0n, traderCount: 0, commentCount: 0,
    }],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (callback) => callback(mocks.tx));
  mocks.tx.marketEvent.findMany.mockResolvedValue([event()]);
  mocks.tx.marketEvent.findUnique.mockResolvedValue(event());
  mocks.marks.mockImplementation(async (_tx, markets: Array<{ id: string }>) => new Map(markets.map(({ id }) => [id, {
    probabilityYesBps: null, source: "NONE", stale: false,
  }])));
});
afterEach(() => vi.useRealTimers());

describe("public event query contract", () => {
  it("defaults and parses scalar query parameters", () => {
    expect(parseEventListQuery({})).toEqual({ timing: "all", limit: 24 });
    expect(parseEventListQuery({ category: " Campus ", timing: "live", limit: "5" })).toEqual({ category: "Campus", timing: "live", limit: 5 });
  });
  it.each([
    { unknown: "value" }, { category: ["Campus"] }, { timing: ["live"] }, { limit: ["5"] }, { cursor: ["value"] },
    { category: " " }, { category: "x".repeat(61) }, { timing: "today" }, { limit: 0 }, { limit: 51 },
    { limit: true }, { limit: null }, { limit: "1.5" }, { cursor: "x".repeat(2049) },
  ])("rejects invalid/array/unknown query %j with ApiError 400", (query) => {
    expect(() => parseEventListQuery(query)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it("rejects repeated URL parameters before reading the database", async () => {
    expect((await listGet(new NextRequest("http://localhost/api/events?limit=1&limit=2"))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("public event reads", () => {
  it("loads only page markets in one serializable transaction and one mark batch", async () => {
    mocks.tx.marketEvent.findMany.mockResolvedValue([event(), event("sentinel")]);
    const result = await listPublicEvents(database, parseEventListQuery({ limit: 1 }));
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.items[0].markets[0]).toMatchObject({ probabilityYesBps: null, probabilitySource: "NONE", probabilityStale: false, traderCount: 0, acceptingOrders: true });
    expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
    expect(mocks.marks).toHaveBeenCalledExactlyOnceWith(mocks.tx, event().markets, expect.any(Date));
    const args = mocks.tx.marketEvent.findMany.mock.calls[0][0];
    expect(args).toMatchObject({ take: 2, orderBy: [{ featured: "desc" }, { startsAt: "asc" }, { id: "asc" }] });
    expect(args.where.markets).toEqual({ some: { ...{ executionBackend: "DATABASE", collateralAccountId: { not: null } }, status: { not: "DRAFT" } } });
    expect(args.select.markets.where).toEqual({ ...{ executionBackend: "DATABASE", collateralAccountId: { not: null } }, status: { not: "DRAFT" } });
  });
  it("preserves independent marks, including zero, stale last fills, and LMSR without normalization", async () => {
    const row = event();
    row.markets = [event("zero").markets[0], event("last").markets[0], { ...event("amm").markets[0], pricingModel: "LMSR" }];
    mocks.tx.marketEvent.findUnique.mockResolvedValue(row);
    mocks.marks.mockResolvedValue(new Map([
      ["zero-market", { probabilityYesBps: 0, source: "SETTLEMENT", stale: false }],
      ["last-market", { probabilityYesBps: 7200, source: "LAST", stale: true }],
      ["amm-market", { probabilityYesBps: 6200, source: "LMSR", stale: false }],
    ]));
    const result = await getPublicEvent(database, row.slug);
    expect(result?.markets.map((market) => [market.probabilityYesBps, market.probabilitySource, market.probabilityStale])).toEqual([
      [0, "SETTLEMENT", false], [7200, "LAST", true], [6200, "LMSR", false],
    ]);
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.tx.marketEvent.findUnique.mock.calls[0][0].select.markets.where).toEqual({ ...{ executionBackend: "DATABASE", collateralAccountId: { not: null } }, status: { not: "DRAFT" } });
  });
  it.each([null, { ...event(), markets: [] }])("returns null for missing or empty/draft-only detail", async (row) => {
    mocks.tx.marketEvent.findUnique.mockResolvedValue(row);
    expect(await getPublicEvent(database, "event-one")).toBeNull();
    expect(mocks.marks).not.toHaveBeenCalled();
    expect((await detailGet(new NextRequest("http://localhost/api/events/event-one"), { params: Promise.resolve({ slug: "event-one" }) })).status).toBe(404);
  });
  it.each(["", "ab", "BAD", "bad/slug", "x".repeat(121)])("returns null for invalid slug %s without a transaction", async (slug) => {
    expect(await getPublicEvent(database, slug)).toBeNull();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("keeps API envelopes, bigint serialization, and cache headers", async () => {
    const list = await listGet(new NextRequest("http://localhost/api/events"));
    expect(await list.json()).toMatchObject({ items: [{ markets: [{ volumeMilli: "0", payoutMilli: "100000" }] }], nextCursor: null });
    expect(list.headers.get("Cache-Control")).toBe("public, max-age=5, stale-while-revalidate=20");
    const detail = await detailGet(new NextRequest("http://localhost/api/events/event-one"), { params: Promise.resolve({ slug: "event-one" }) });
    expect(await detail.json()).toMatchObject({ event: { id: "event-one", markets: [{ probabilityYesBps: null }] } });
  });
});

describe("event keyset cursors", () => {
  async function firstPage(featured = true, timing = "live") {
    mocks.tx.marketEvent.findMany.mockResolvedValue([event("event-a", featured), event("event-b", featured)]);
    const query = parseEventListQuery({ category: "Campus", timing, limit: 1 });
    return { query, cursor: (await listPublicEvents(database, query)).nextCursor! };
  }
  it.each([true, false])("continues after a %s-featured tie using startsAt and id", async (featured) => {
    const { query, cursor } = await firstPage(featured);
    mocks.tx.marketEvent.findMany.mockResolvedValue([event("event-b", featured)]);
    const result = await listPublicEvents(database, { ...query, cursor });
    expect(result.items.map(({ id }) => id)).toEqual(["event-b"]);
    expect(result.nextCursor).toBeNull();
    expect(mocks.tx.marketEvent.findMany.mock.lastCall?.[0].where.AND).toEqual([{ OR: [
      ...(featured ? [{ featured: false }] : []),
      { featured, startsAt: { gt: instant } },
      { featured, startsAt: instant, id: { gt: "event-a" } },
    ] }]);
  });
  it("freezes timing membership but computes current marks on subsequent pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(instant);
    const { query, cursor } = await firstPage();
    const later = new Date("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(later);
    await listPublicEvents(database, { ...query, cursor });
    expect(mocks.tx.marketEvent.findMany.mock.lastCall?.[0].where).toMatchObject({ startsAt: { lte: instant }, endsAt: { gt: instant } });
    expect(mocks.marks.mock.lastCall?.[2]).toEqual(later);
  });
  it.each(["upcoming", "past", "all"])("applies the %s timing filter", async (timing) => {
    vi.useFakeTimers(); vi.setSystemTime(instant);
    await listPublicEvents(database, parseEventListQuery({ timing }));
    const where = mocks.tx.marketEvent.findMany.mock.lastCall?.[0].where;
    if (timing === "upcoming") expect(where.startsAt).toEqual({ gt: instant });
    else if (timing === "past") expect(where.endsAt).toEqual({ lte: instant });
    else { expect(where).not.toHaveProperty("startsAt"); expect(where).not.toHaveProperty("endsAt"); }
  });
  it("rejects noncanonical, malformed, and filter-mismatched cursors", async () => {
    const { query, cursor } = await firstPage();
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const invalid of ["!", "e30", `${cursor}=`, encode({ ...decoded, v: 2 }), encode({ ...decoded, extra: true }), encode({ ...decoded, startsAt: "2026-02-30T00:00:00.000Z" }), Buffer.from(` ${JSON.stringify(decoded)}`).toString("base64url")]) {
      expect(() => parseEventListQuery({ ...query, cursor: invalid })).toThrow(expect.objectContaining({ status: 400 }));
    }
    expect(() => parseEventListQuery({ ...query, category: "Hackathon", cursor })).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(() => parseEventListQuery({ ...query, timing: "past", cursor })).toThrow(expect.objectContaining({ code: "INVALID_CURSOR" }));
    expect(parseEventListQuery({ ...query, limit: 5, cursor }).limit).toBe(5);
  });
});
