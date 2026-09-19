import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const market = vi.fn();
  const fills = vi.fn();
  const priorFill = vi.fn();
  const snapshots = vi.fn();
  const priorSnapshot = vi.fn();
  const trades = vi.fn();
  const tx = {
    market: { findUnique: market },
    orderFill: { findMany: fills, findFirst: priorFill },
    marketPriceSnapshot: { findMany: snapshots, findFirst: priorSnapshot },
    trade: { findMany: trades },
  };
  return {
    market,
    fills,
    priorFill,
    snapshots,
    priorSnapshot,
    trades,
    tx,
    auth: vi.fn(),
    runSerializableTransaction: vi.fn((_client: unknown, operation: (transaction: typeof tx) => unknown) => operation(tx)),
  };
});

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    prisma: {},
    apiErrorResponse: (error: unknown) => {
      const candidate = error as { status?: number; code?: string; message?: string };
      return Response.json(
        { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message ?? "error" } },
        { status: candidate.status ?? 500, headers: { "Cache-Control": "private, no-store" } },
      );
    },
  };
});
vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: mocks.auth }));
vi.mock("@/lib/serializable-transaction", () => ({ runSerializableTransaction: mocks.runSerializableTransaction }));

import { GET } from "./route";

const NOW = new Date("2026-09-19T16:00:00.000Z");

function request(query = "") {
  return new NextRequest(`http://localhost/api/markets/book/history${query}`);
}

function context(slug = "book") {
  return { params: Promise.resolve({ slug }) };
}

describe("market history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.auth.mockResolvedValue(null);
    mocks.market.mockResolvedValue({ id: "book", status: "OPEN", pricingModel: "ORDER_BOOK", payoutMilli: 100_000n });
    mocks.fills.mockResolvedValue([]);
    mocks.priorFill.mockResolvedValue(null);
    mocks.snapshots.mockResolvedValue([]);
    mocks.priorSnapshot.mockResolvedValue(null);
    mocks.trades.mockResolvedValue([]);
  });

  it("returns empty CLOB observations rather than a seeded market-maker price", async () => {
    const response = await GET(request("?range=ALL"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ snapshots: [], trades: [], sampledFrom: 0, source: "EXECUTIONS", rangeStart: null });
    expect(mocks.runSerializableTransaction).toHaveBeenCalledOnce();
    expect(mocks.market).toHaveBeenCalledWith({
      where: { slug: "book" },
      select: { id: true, status: true, pricingModel: true, payoutMilli: true },
    });
    expect(mocks.snapshots).not.toHaveBeenCalled();
    expect(mocks.priorFill).not.toHaveBeenCalled();
  });

  it("loads CLOB executions from the snapshot client in causal order and normalizes by payout", async () => {
    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    mocks.fills.mockResolvedValue([
      { id: "random-z", tradeSequence: 4n, canonicalYesPriceMilli: 30_005n, createdAt },
      { id: "random-a", tradeSequence: 5n, canonicalYesPriceMilli: 70_000n, createdAt },
    ]);

    const response = await GET(request("?range=ALL"), context());
    const body = await response.json();

    expect(body.snapshots.map((point: { id: string; yesProbabilityBps: number }) => [point.id, point.yesProbabilityBps])).toEqual([
      ["random-z", 3001],
      ["random-a", 7000],
    ]);
    expect(mocks.fills).toHaveBeenCalledWith({
      where: { marketId: "book" },
      orderBy: [{ createdAt: "asc" }, { tradeSequence: "asc" }, { id: "asc" }],
      select: { id: true, createdAt: true, tradeSequence: true, canonicalYesPriceMilli: true },
    });
  });

  it("uses one stable range boundary for CLOB rows and the preceding execution", async () => {
    const since = new Date(NOW.getTime() - 86_400_000);
    mocks.priorFill.mockResolvedValue({ id: "prior", tradeSequence: 3n, canonicalYesPriceMilli: 40_000n, createdAt: new Date("2020-01-01T00:00:00.000Z") });

    const response = await GET(request("?range=1D"), context());
    const body = await response.json();

    expect(body.rangeStart).toBe(since.toISOString());
    expect(body.snapshots[0].yesProbabilityBps).toBe(4000);
    expect(mocks.fills).toHaveBeenCalledWith(expect.objectContaining({ where: { marketId: "book", createdAt: { gte: since } } }));
    expect(mocks.priorFill).toHaveBeenCalledWith({
      where: { marketId: "book", createdAt: { lt: since } },
      orderBy: [{ createdAt: "desc" }, { tradeSequence: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true, tradeSequence: true, canonicalYesPriceMilli: true },
    });
  });

  it("loads legacy snapshots, prior point, and trades from the same serializable snapshot", async () => {
    const since = new Date(NOW.getTime() - 604_800_000);
    const prior = { id: "snapshot-prior", marketId: "lmsr", yesProbabilityBps: 4500, createdAt: new Date("2026-09-01T00:00:00.000Z") };
    const current = { id: "snapshot-current", marketId: "lmsr", yesProbabilityBps: 5500, createdAt: new Date("2026-09-18T00:00:00.000Z") };
    const trade = { id: "trade", side: "YES", action: "BUY", quantity: 2, amountMilli: 10_000n, feeMilli: 100n, priceBeforeBps: 5000, priceAfterBps: 5500, createdAt: current.createdAt };
    mocks.market.mockResolvedValue({ id: "lmsr", status: "OPEN", pricingModel: "LMSR", payoutMilli: 100_000n });
    mocks.priorSnapshot.mockResolvedValue(prior);
    mocks.snapshots.mockResolvedValue([current]);
    mocks.trades.mockResolvedValue([trade]);

    const response = await GET(request("?range=1W&limit=25"), context("lmsr"));
    const body = await response.json();

    expect(body.snapshots.map((row: { id: string }) => row.id)).toEqual(["snapshot-prior", "snapshot-current"]);
    expect(body.trades[0]).toMatchObject({ id: "trade", amountMilli: "10000", feeMilli: "100" });
    expect(mocks.snapshots).toHaveBeenCalledWith(expect.objectContaining({ where: { marketId: "lmsr", createdAt: { gte: since } } }));
    expect(mocks.priorSnapshot).toHaveBeenCalledWith(expect.objectContaining({ where: { marketId: "lmsr", createdAt: { lt: since } } }));
    expect(mocks.trades).toHaveBeenCalledWith(expect.objectContaining({ where: { marketId: "lmsr", createdAt: { gte: since } }, take: 25 }));
    expect(mocks.fills).not.toHaveBeenCalled();
  });

  it.each([
    "?range=1D&range=1W",
    "?limit=10&limit=20",
    "?range=ALL&unknown=value",
  ])("rejects unknown or repeated query parameters before authentication or database reads: %s", async (query) => {
    const response = await GET(request(query), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.runSerializableTransaction).not.toHaveBeenCalled();
  });

  it("keeps draft history hidden unless requested by an admin", async () => {
    mocks.market.mockResolvedValue({ id: "draft", status: "DRAFT", pricingModel: "ORDER_BOOK", payoutMilli: 100_000n });

    const hidden = await GET(request("?range=ALL"), context("draft"));
    expect(hidden.status).toBe(404);
    expect(mocks.fills).not.toHaveBeenCalled();

    mocks.auth.mockResolvedValue({ id: "admin", role: "ADMIN" });
    const visible = await GET(request("?range=ALL"), context("draft"));
    expect(visible.status).toBe(200);
    expect(visible.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.fills).toHaveBeenCalledOnce();
  });

  it("returns a private no-store error when the snapshot read fails", async () => {
    mocks.runSerializableTransaction.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(request("?range=ALL"), context());

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.fills).not.toHaveBeenCalled();
  });
});
