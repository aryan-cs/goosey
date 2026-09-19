import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { probabilityYesBps } from "./market-maker";
import { loadMarketMarks, type MarketMarkInput } from "./market-marks";

const NOW = new Date("2026-09-19T14:00:00.000Z");

const groupBy = vi.fn();
const findMarkets = vi.fn();
const tx = {
  marketOrder: { groupBy },
  market: { findMany: findMarkets },
} as unknown as Prisma.TransactionClient;

function market(overrides: Partial<MarketMarkInput> = {}): MarketMarkInput {
  return {
    id: "market",
    pricingModel: "ORDER_BOOK",
    status: "OPEN",
    resolution: null,
    closesAt: new Date(NOW.getTime() + 60_000),
    acceptingOrders: true,
    payoutMilli: 100_000n,
    yesShares: 0,
    noShares: 0,
    liquidityParameter: 100,
    ...overrides,
  };
}

describe("market mark batch loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupBy.mockResolvedValue([]);
    findMarkets.mockResolvedValue([]);
  });

  it("uses the payout-aware LMSR probability without database depth reads", async () => {
    const input = market({ pricingModel: "LMSR", yesShares: 175, noShares: 25, liquidityParameter: 80, payoutMilli: 250_000n });

    const marks = await loadMarketMarks(tx, [input], NOW);

    expect(marks.get(input.id)).toEqual({
      probabilityYesBps: probabilityYesBps({ yesQuantity: 175, noQuantity: 25, liquidity: 80, payoutMilli: 250_000n }),
      source: "LMSR",
      stale: false,
    });
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMarkets).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "RESOLVED", resolution: "YES" }, 10_000],
    [{ status: "RESOLVED", resolution: "NO" }, 0],
    [{ status: "RESOLVING", resolution: "YES" }, 10_000],
    [{ status: "RESOLVING", resolution: "NO" }, 0],
    [{ status: "RESOLVING", resolution: "VOID" }, 5_000],
    [{ status: "VOID", resolution: null }, 5_000],
  ])("uses authoritative terminal settlement for %o", async (state, probability) => {
    const input = market(state);
    const marks = await loadMarketMarks(tx, [input], NOW);
    expect(marks.get(input.id)).toEqual({ probabilityYesBps: probability, source: "SETTLEMENT", stale: false });
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMarkets).not.toHaveBeenCalled();
  });

  it("returns NONE rather than a synthetic midpoint for an empty order book", async () => {
    findMarkets.mockResolvedValue([{ id: "market", orderFills: [] }]);

    const marks = await loadMarketMarks(tx, [market()], NOW);

    expect(marks.get("market")).toEqual({ probabilityYesBps: null, source: "NONE", stale: false });
  });

  it("maps persisted BUY/SELL depth to a qualified canonical midpoint", async () => {
    groupBy.mockResolvedValue([
      { marketId: "market", bookSide: "BUY", limitPriceMilli: 45_000n, _sum: { remainingQuantity: 3 } },
      { marketId: "market", bookSide: "SELL", limitPriceMilli: 55_000n, _sum: { remainingQuantity: 2 } },
    ]);
    findMarkets.mockResolvedValue([{ id: "market", orderFills: [] }]);

    const marks = await loadMarketMarks(tx, [market()], NOW);

    expect(marks.get("market")).toEqual({ probabilityYesBps: 5_000, source: "MID", stale: false });
  });

  it("scopes aggregated depth to live, unexpired orders owned by active users", async () => {
    findMarkets.mockResolvedValue([{ id: "market", orderFills: [] }]);

    await loadMarketMarks(tx, [market()], NOW);

    expect(groupBy).toHaveBeenCalledWith({
      by: ["marketId", "bookSide", "limitPriceMilli"],
      where: {
        marketId: { in: ["market"] },
        user: { status: "ACTIVE", role: "USER" },
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
      },
      _sum: { remainingQuantity: true },
    });
    expect(findMarkets).toHaveBeenCalledWith({
      where: { id: { in: ["market"] } },
      select: {
        id: true,
        orderFills: {
          orderBy: { tradeSequence: "desc" },
          take: 1,
          select: { canonicalYesPriceMilli: true, createdAt: true },
        },
      },
    });
  });

  it.each([
    { status: "PAUSED", acceptingOrders: true, closesAt: new Date(NOW.getTime() + 60_000) },
    { status: "OPEN", acceptingOrders: false, closesAt: new Date(NOW.getTime() + 60_000) },
    { status: "OPEN", acceptingOrders: true, closesAt: NOW },
  ])("does not use quoted depth when the market is unavailable: %o", async (state) => {
    findMarkets.mockResolvedValue([{
      id: "market",
      orderFills: [{ canonicalYesPriceMilli: 40_000n, createdAt: new Date(NOW.getTime() - 1_000) }],
    }]);

    const marks = await loadMarketMarks(tx, [market(state)], NOW);

    expect(groupBy).not.toHaveBeenCalled();
    expect(marks.get("market")).toEqual({ probabilityYesBps: 4_000, source: "LAST", stale: false });
  });

  it("reports stale LAST metadata using selectMarketMark defaults", async () => {
    findMarkets.mockResolvedValue([{
      id: "market",
      orderFills: [{ canonicalYesPriceMilli: 63_000n, createdAt: new Date(NOW.getTime() - 3_600_001) }],
    }]);

    const marks = await loadMarketMarks(tx, [market()], NOW);

    expect(marks.get("market")).toEqual({ probabilityYesBps: 6_300, source: "LAST", stale: true });
  });

  it("uses the actual canonical ask rather than complementing persisted SELL prices", async () => {
    groupBy.mockResolvedValue([
      { marketId: "market", bookSide: "BUY", limitPriceMilli: 30_000n, _sum: { remainingQuantity: 1 } },
      { marketId: "market", bookSide: "SELL", limitPriceMilli: 40_000n, _sum: { remainingQuantity: 1 } },
    ]);
    findMarkets.mockResolvedValue([{ id: "market", orderFills: [] }]);

    const marks = await loadMarketMarks(tx, [market()], NOW);

    expect(marks.get("market")).toEqual({ probabilityYesBps: 3_500, source: "MID", stale: false });
  });
});
