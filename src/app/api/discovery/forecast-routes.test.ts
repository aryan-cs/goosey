import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    market: { findMany: vi.fn(), findUnique: vi.fn() },
    marketEvent: { findMany: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
  };
  return { tx, transaction: vi.fn(), loadMarketMarks: vi.fn(), getAuthenticatedUser: vi.fn() };
});

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const jsonResponse = (data: unknown, init?: ResponseInit) => NextResponse.json(
    JSON.parse(JSON.stringify(data, (_key, value) => typeof value === "bigint" ? value.toString() : value)),
    init,
  );
  return {
    prisma: { $transaction: mocks.transaction, user: { findUnique: mocks.tx.user.findUnique } },
    ApiError,
    jsonResponse,
    apiErrorResponse: (error: unknown) => jsonResponse(
      { error: { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
      { status: error instanceof ApiError ? error.status : 500 },
    ),
  };
});
vi.mock("@/lib/market-marks", () => ({ loadMarketMarks: mocks.loadMarketMarks }));
vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: mocks.getAuthenticatedUser }));

import { GET as marketsGet } from "../markets/route";
import { GET as marketGet } from "../markets/[slug]/route";
import { GET as searchGet } from "../search/route";
import { GET as discoveryGet } from "./route";
import { GET as eventsGet } from "../events/route";
import { GET as eventGet } from "../events/[slug]/route";
import { GET as calendarGet } from "../calendar/route";

const recordedAt = new Date("2026-09-19T10:00:00Z");
function market(id: string, pricingModel = "ORDER_BOOK") {
  return {
    id, slug: id, title: id, shortTitle: id, description: "Forecast contract", rules: "Rules",
    resolutionSource: "Source", category: "Campus", featured: false, color: "gold", icon: "sparkles",
    executionBackend: "DATABASE", collateralAccountId: `collateral-${id}`,
    pricingModel, status: "OPEN", resolution: null, acceptingOrders: true,
    closesAt: new Date("2099-01-01T00:00:00Z"), payoutMilli: 1_000n,
    yesShares: 0, noShares: 0, liquidityParameter: 100, volumeMilli: 0n, traderCount: 0,
    commentCount: 0, createdAt: recordedAt, updatedAt: recordedAt,
    // An initial snapshot must not become trade history for an untraded book.
    priceHistory: [{ createdAt: recordedAt, yesProbabilityBps: 5_000 }],
    orderFills: [] as Array<{ createdAt: Date; canonicalYesPriceMilli: bigint }>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (operation) => operation(mocks.tx));
  mocks.getAuthenticatedUser.mockResolvedValue(null);
  const markets = [market("empty-book"), market("amm", "LMSR")];
  const event = { id: "event", slug: "event", title: "Campus", markets, _count: { markets: 2 } };
  mocks.tx.market.findMany.mockImplementation(async (args?: { where?: { executionBackend?: string } }) =>
    args?.where?.executionBackend === "SOLANA" ? [] : markets);
  mocks.tx.market.findUnique.mockResolvedValue(markets[0]);
  mocks.tx.marketEvent.findMany.mockResolvedValue([event]);
  mocks.tx.marketEvent.findUnique.mockResolvedValue(event);
  mocks.tx.user.findMany.mockResolvedValue([]);
  mocks.loadMarketMarks.mockImplementation(async (_tx, rows) => new Map(rows.map((row: { id: string; pricingModel: string }) => [
    row.id, row.pricingModel === "LMSR"
      ? { probabilityYesBps: 6_250, source: "LMSR", stale: false }
      : { probabilityYesBps: null, source: "NONE", stale: false },
  ])));
});

describe("forecast API batch mark contract", () => {
  it.each([
    ["markets", () => marketsGet(new NextRequest("http://localhost/api/markets?status=OPEN&status=CLOSED"))],
    ["calendar", () => calendarGet(new NextRequest("http://localhost/api/calendar?category=Campus&category=Hacking"))],
  ] as const)("rejects ambiguous %s filters before reading data", async (_name, get) => {
    const response = await get();
    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.loadMarketMarks).not.toHaveBeenCalled();
  });

  const routes = [
    ["markets", () => marketsGet(new NextRequest("http://localhost/api/markets")), "items"],
    ["search", () => searchGet(new NextRequest("http://localhost/api/search?q=book")), "markets"],
    ["calendar", () => calendarGet(new NextRequest("http://localhost/api/calendar")), "markets"],
    ["events", () => eventsGet(new NextRequest("http://localhost/api/events")), "items"],
    ["event", () => eventGet(new NextRequest("http://localhost/api/events/event"), { params: Promise.resolve({ slug: "event" }) }), "event"],
  ] as const;

  it.each(routes)("%s uses one transaction and one batch, preserving absent marks", async (name, get, key) => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    const rows = name === "events" ? body.items[0].markets : name === "event" ? body.event.markets : body[key];
    expect(rows.find((row: { id: string }) => row.id === "empty-book")).toMatchObject({
      probabilityYesBps: null, probabilitySource: "NONE", probabilityStale: false,
    });
    expect(rows.find((row: { id: string }) => row.id === "amm")).toMatchObject({
      probabilityYesBps: 6_250, probabilitySource: "LMSR", probabilityStale: false,
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "Serializable" });
    expect(mocks.loadMarketMarks).toHaveBeenCalledTimes(1);
    expect(mocks.loadMarketMarks.mock.calls[0][0]).toBe(mocks.tx);
    expect(mocks.loadMarketMarks.mock.calls[0][1]).toHaveLength(2);
  });

  it("market listing uses only real CLOB fills and retains the LMSR chronological helper", async () => {
    const response = await marketsGet(new NextRequest("http://localhost/api/markets"));
    const body = await response.json();
    expect(body.items.find((item: { id: string }) => item.id === "empty-book").priceHistory).toEqual([]);
    expect(body.items.find((item: { id: string }) => item.id === "amm").priceHistory
      .map((point: { probabilityYesBps: number }) => point.probabilityYesBps)).toEqual([5_000, 6_250]);
    expect(body.items[0]).not.toHaveProperty("orderFills");
  });

  it("discovery deduplicates its batch and excludes null marks from movers", async () => {
    const body = await (await discoveryGet()).json();
    expect(body.trending[0]).toMatchObject({ probabilityYesBps: null, priceHistory: [] });
    expect(body.movers.map((row: { id: string }) => row.id)).toEqual(["amm"]);
    expect(mocks.loadMarketMarks).toHaveBeenCalledTimes(1);
    expect(mocks.loadMarketMarks.mock.calls[0][1]).toHaveLength(2);
    expect(mocks.loadMarketMarks.mock.calls[0][0]).toBe(mocks.tx);
  });

  it("preserves a genuine zero mark and stale last-fill metadata", async () => {
    mocks.loadMarketMarks.mockResolvedValue(new Map([
      ["empty-book", { probabilityYesBps: 0, source: "LAST", stale: true }],
      ["amm", { probabilityYesBps: 6_250, source: "LMSR", stale: false }],
    ]));
    const body = await (await discoveryGet()).json();
    expect(body.movers.find((row: { id: string }) => row.id === "empty-book")).toMatchObject({
      probabilityYesBps: 0, probabilitySource: "LAST", probabilityStale: true,
    });
  });

  it("loads marks only for the returned market page, not its pagination sentinel", async () => {
    const body = await (await marketsGet(new NextRequest("http://localhost/api/markets?limit=1"))).json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(mocks.loadMarketMarks.mock.calls[0][1].map((row: { id: string }) => row.id)).toEqual(["empty-book", "amm"]);
  });

  it("emits chronological, rounded fill history without a synthetic current midpoint", async () => {
    const book = market("traded-book");
    book.payoutMilli = 3_000n;
    book.orderFills = [
      { createdAt: new Date("2026-09-19T11:00:00Z"), canonicalYesPriceMilli: 2_000n },
      { createdAt: recordedAt, canonicalYesPriceMilli: 1_000n },
    ];
    mocks.tx.market.findMany.mockResolvedValue([book]);
    mocks.loadMarketMarks.mockResolvedValue(new Map([[book.id, { probabilityYesBps: 7_000, source: "MID", stale: false }]]));
    const body = await (await discoveryGet()).json();
    expect(body.trending[0].priceHistory).toEqual([
      { timestamp: recordedAt.toISOString(), probabilityYesBps: 3_333 },
      { timestamp: "2026-09-19T11:00:00.000Z", probabilityYesBps: 6_667 },
    ]);
    expect(body.trending[0].probabilityYesBps).toBe(7_000);
  });

  it("detail preserves null probability, raw history naming, and private-field redaction", async () => {
    mocks.tx.market.findUnique.mockResolvedValue({ ...market("empty-book"), collateralAccountId: "private", createdById: "private" });
    const body = await (await marketGet(new NextRequest("http://localhost/api/markets/empty-book"), { params: Promise.resolve({ slug: "empty-book" }) })).json();
    expect(body).toMatchObject({ probabilityYesBps: null, probabilitySource: "NONE", priceHistory: [] });
    expect(body).not.toHaveProperty("collateralAccountId");
    expect(body).not.toHaveProperty("createdById");
    expect(body).not.toHaveProperty("orderFills");
  });

  it("does not load marks or reveal a draft to non-admins", async () => {
    mocks.tx.market.findUnique.mockResolvedValue({ ...market("draft-book"), status: "DRAFT" });
    const response = await marketGet(new NextRequest("http://localhost/api/markets/draft-book"), { params: Promise.resolve({ slug: "draft-book" }) });
    expect(response.status).toBe(404);
    expect(mocks.loadMarketMarks).not.toHaveBeenCalled();
  });

  it("preserves public search profile and event draft filters", async () => {
    await searchGet(new NextRequest("http://localhost/api/search?q=campus"));
    expect(mocks.tx.user.findMany.mock.calls[0][0].where).toMatchObject({ role: "USER", status: "ACTIVE", profilePublic: true });
    expect(mocks.tx.market.findMany.mock.calls[0][0].where.status).toEqual({ not: "DRAFT" });
    expect(mocks.tx.marketEvent.findMany.mock.calls[0][0].where.markets).toEqual({ some: { ...{ executionBackend: "DATABASE", collateralAccountId: { not: null } }, status: { not: "DRAFT" } } });
  });
});
