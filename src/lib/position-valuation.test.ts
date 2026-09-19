import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadPositionValuations } from "./position-valuation";

const now = new Date("2026-09-19T14:00:00Z");
function holding() {
  return {
    id: "position", userId: "holder", marketId: "market", yesShares: 10, noShares: 0,
    market: { id: "market", pricingModel: "ORDER_BOOK", status: "OPEN", resolution: null, payoutMilli: 100_000n, feeBps: 100, closesAt: new Date(now.getTime() + 60_000), acceptingOrders: true },
  } as Parameters<typeof loadPositionValuations>[1][number];
}

function client(last = true) {
  const orders = vi.fn().mockResolvedValue([
    { marketId: "market", userId: "counterparty", stpOwnerId: "counterparty", bookSide: "BUY", limitPriceMilli: 30_000n, remainingQuantity: 4, status: "OPEN", expiresAt: null },
    { marketId: "market", userId: "holder", stpOwnerId: "holder", bookSide: "BUY", limitPriceMilli: 90_000n, remainingQuantity: 10, status: "OPEN", expiresAt: null },
  ]);
  const markets = vi.fn().mockResolvedValue([{ id: "market", orderFills: last ? [{ canonicalYesPriceMilli: 40_000n, createdAt: now }] : [] }]);
  return { orders, markets, tx: { marketOrder: { findMany: orders }, market: { findMany: markets } } as unknown as Prisma.TransactionClient };
}

describe("position valuation snapshot", () => {
  it("loads scoped active depth, uses real liquidity, and excludes own orders from proceeds", async () => {
    const db = client();
    const results = await loadPositionValuations(db.tx, [holding()], now);
    expect(results.get("position")).toMatchObject({ valueMilli: 118_800n, yes: 118_800n, no: 0n, unfilledYes: 6, unfilledNo: 0, probabilityYesBps: 4000, method: "ORDER_BOOK_LIQUIDATION" });
    expect(db.orders).toHaveBeenCalledWith(expect.objectContaining({ where: {
      marketId: { in: ["market"] }, user: { status: "ACTIVE", role: "USER" }, status: { in: ["OPEN", "PARTIALLY_FILLED"] }, remainingQuantity: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    } }));
    expect(db.markets).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["market"] } } }));
  });

  it("does not invent a 50 percent forecast when no market price exists", async () => {
    const db = client(false);
    db.orders.mockResolvedValue([]);
    const results = await loadPositionValuations(db.tx, [holding()], now);
    expect(results.get("position")).toMatchObject({ valueMilli: 0n, unfilledYes: 10, probabilityYesBps: null });
  });

  it.each([
    ["RESOLVED", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION"],
    ["RESOLVING", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION"],
    ["RESOLVED", "LMSR", "MARKET_MAKER"],
    ["RESOLVING", "LMSR", "MARKET_MAKER"],
  ] as const)("uses the 50 percent void settlement mark for %s %s", async (status, pricingModel, method) => {
    const db = client();
    const position = holding();
    position.market.status = status;
    position.market.resolution = "VOID";
    position.market.pricingModel = pricingModel;

    const results = await loadPositionValuations(db.tx, [position], now);

    expect(results.get("position")).toMatchObject({
      probabilityYesBps: 5000,
      valueMilli: 500_000n,
      yes: 500_000n,
      no: 0n,
      unfilledYes: 0,
      unfilledNo: 0,
      method,
    });
    if (pricingModel === "LMSR") {
      expect(db.orders).not.toHaveBeenCalled();
      expect(db.markets).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["RESOLVED", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION", "YES", 10, 0, 10_000, 1_000_000n, 1_000_000n, 0n],
    ["RESOLVED", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION", "NO", 0, 10, 0, 1_000_000n, 0n, 1_000_000n],
    ["RESOLVING", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION", "YES", 10, 0, 10_000, 1_000_000n, 1_000_000n, 0n],
    ["RESOLVING", "ORDER_BOOK", "ORDER_BOOK_LIQUIDATION", "NO", 0, 10, 0, 1_000_000n, 0n, 1_000_000n],
    ["RESOLVED", "LMSR", "MARKET_MAKER", "YES", 10, 0, 10_000, 1_000_000n, 1_000_000n, 0n],
    ["RESOLVED", "LMSR", "MARKET_MAKER", "NO", 0, 10, 0, 1_000_000n, 0n, 1_000_000n],
    ["RESOLVING", "LMSR", "MARKET_MAKER", "YES", 10, 0, 10_000, 1_000_000n, 1_000_000n, 0n],
    ["RESOLVING", "LMSR", "MARKET_MAKER", "NO", 0, 10, 0, 1_000_000n, 0n, 1_000_000n],
  ] as const)("uses the %s %s %s settlement forecast and payout", async (
    status,
    pricingModel,
    method,
    resolution,
    yesShares,
    noShares,
    probabilityYesBps,
    valueMilli,
    yes,
    no,
  ) => {
    const db = client();
    const position = holding();
    position.yesShares = yesShares;
    position.noShares = noShares;
    position.market.status = status;
    position.market.resolution = resolution;
    position.market.pricingModel = pricingModel;

    const results = await loadPositionValuations(db.tx, [position], now);

    expect(results.get("position")).toMatchObject({
      probabilityYesBps,
      valueMilli,
      yes,
      no,
      unfilledYes: 0,
      unfilledNo: 0,
      method,
    });
    if (pricingModel === "LMSR") {
      expect(db.orders).not.toHaveBeenCalled();
      expect(db.markets).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["ORDER_BOOK", "ORDER_BOOK_LIQUIDATION"],
    ["LMSR", "MARKET_MAKER"],
  ] as const)("preserves an odd complete-pair VOID payout for %s", async (pricingModel, method) => {
    const db = client();
    const position = holding();
    position.yesShares = 1;
    position.noShares = 1;
    position.market.pricingModel = pricingModel;
    position.market.status = "RESOLVING";
    position.market.resolution = "VOID";
    position.market.payoutMilli = 3n;

    const results = await loadPositionValuations(db.tx, [position], now);

    expect(results.get("position")).toMatchObject({
      probabilityYesBps: 5000,
      valueMilli: 3n,
      yes: 1n,
      no: 2n,
      unfilledYes: 0,
      unfilledNo: 0,
      method,
    });
    if (pricingModel === "LMSR") {
      expect(db.orders).not.toHaveBeenCalled();
      expect(db.markets).not.toHaveBeenCalled();
    }
  });

  it("skips depth queries when there are no positions", async () => {
    const db = client();
    expect((await loadPositionValuations(db.tx, [], now)).size).toBe(0);
    expect(db.orders).not.toHaveBeenCalled();
    expect(db.markets).not.toHaveBeenCalled();
  });
});
