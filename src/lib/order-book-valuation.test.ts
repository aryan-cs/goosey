import { describe, expect, it } from "vitest";

import { valueOrderBookPosition, type ValuationOrder } from "./order-book-valuation";

const NOW = new Date("2026-09-19T12:00:00.000Z");

function market(overrides: Record<string, unknown> = {}) {
  return {
    payoutMilli: 100_000n,
    feeBps: 0,
    status: "OPEN",
    resolution: null,
    closesAt: new Date("2026-09-20T12:00:00.000Z"),
    acceptingOrders: true,
    ...overrides,
  } as Parameters<typeof valueOrderBookPosition>[0]["market"];
}

function position(yesShares: number, noShares: number) {
  return { userId: "holder", yesShares, noShares };
}

function order(overrides: Partial<ValuationOrder> = {}): ValuationOrder {
  return {
    userId: "external",
    stpOwnerId: "external",
    bookSide: "BUY",
    limitPriceMilli: 50_000n,
    remainingQuantity: 1,
    status: "OPEN",
    expiresAt: null,
    ...overrides,
  };
}

describe("order-book position valuation", () => {
  it("values complete pairs at collateral and leaves unmatched shares worthless without a book", () => {
    expect(valueOrderBookPosition({ market: market(), position: position(3, 1), orders: [], now: NOW })).toEqual({
      yes: 50_000n,
      no: 50_000n,
      valueMilli: 100_000n,
      unfilledYes: 2,
      unfilledNo: 0,
    });
  });

  it("sweeps partial YES bid depth from highest price to lowest", () => {
    const value = valueOrderBookPosition({
      market: market(),
      position: position(4, 0),
      orders: [
        order({ limitPriceMilli: 60_000n, remainingQuantity: 2 }),
        order({ limitPriceMilli: 70_000n, remainingQuantity: 1 }),
        order({ limitPriceMilli: 50_000n, remainingQuantity: 5 }),
      ],
      now: NOW,
    });

    expect(value).toEqual({ yes: 240_000n, no: 0n, valueMilli: 240_000n, unfilledYes: 0, unfilledNo: 0 });
  });

  it("values NO against descending complements of canonical asks", () => {
    const value = valueOrderBookPosition({
      market: market(),
      position: position(0, 2),
      orders: [
        order({ bookSide: "SELL", limitPriceMilli: 30_000n }),
        order({ bookSide: "SELL", limitPriceMilli: 40_000n }),
        order({ bookSide: "SELL", limitPriceMilli: 90_000n, remainingQuantity: 4 }),
      ],
      now: NOW,
    });

    expect(value).toEqual({ yes: 0n, no: 130_000n, valueMilli: 130_000n, unfilledYes: 0, unfilledNo: 0 });
  });

  it("excludes the holder's user and STP-owner orders before liquidation", () => {
    const value = valueOrderBookPosition({
      market: market(),
      position: position(2, 0),
      orders: [
        order({ userId: "holder", stpOwnerId: "holder", limitPriceMilli: 90_000n, remainingQuantity: 2 }),
        order({ userId: "delegate", stpOwnerId: "holder", limitPriceMilli: 80_000n, remainingQuantity: 2 }),
        order({ limitPriceMilli: 70_000n }),
      ],
      now: NOW,
    });

    expect(value).toEqual({ yes: 70_000n, no: 0n, valueMilli: 70_000n, unfilledYes: 1, unfilledNo: 0 });
  });

  it("ignores expired, inactive, and zero-quantity orders", () => {
    const value = valueOrderBookPosition({
      market: market(),
      position: position(2, 0),
      orders: [
        order({ limitPriceMilli: 99_000n, expiresAt: NOW }),
        order({ limitPriceMilli: 98_000n, status: "CANCELED" }),
        order({ limitPriceMilli: 97_000n, remainingQuantity: 0 }),
        order({ limitPriceMilli: 40_000n, status: "PARTIALLY_FILLED" }),
      ],
      now: NOW,
    });

    expect(value).toEqual({ yes: 40_000n, no: 0n, valueMilli: 40_000n, unfilledYes: 1, unfilledNo: 0 });
  });

  it("charges one cumulatively rounded fee over aggregate own-side gross", () => {
    const value = valueOrderBookPosition({
      market: market({ feeBps: 1 }),
      position: position(2, 0),
      orders: [order({ limitPriceMilli: 1n }), order({ limitPriceMilli: 1n })],
      now: NOW,
    });

    expect(value).toEqual({ yes: 1n, no: 0n, valueMilli: 1n, unfilledYes: 0, unfilledNo: 0 });
  });

  it("uses actual terminal payouts and an exact aggregate VOID half-payout", () => {
    const oddPayout = 100_001n;
    const resolvedInput = { position: position(2, 3), orders: [order({ limitPriceMilli: 99_000n })], now: NOW };

    expect(valueOrderBookPosition({ ...resolvedInput, market: market({ payoutMilli: oddPayout, status: "RESOLVED", resolution: "YES" }) })).toEqual({
      yes: 200_002n, no: 0n, valueMilli: 200_002n, unfilledYes: 0, unfilledNo: 0,
    });
    expect(valueOrderBookPosition({ ...resolvedInput, market: market({ payoutMilli: oddPayout, status: "RESOLVED", resolution: "NO" }) })).toEqual({
      yes: 0n, no: 300_003n, valueMilli: 300_003n, unfilledYes: 0, unfilledNo: 0,
    });
    expect(valueOrderBookPosition({ ...resolvedInput, market: market({ payoutMilli: oddPayout, status: "VOID", resolution: null }) })).toEqual({
      yes: 100_001n, no: 150_001n, valueMilli: 250_002n, unfilledYes: 0, unfilledNo: 0,
    });
  });

  it.each([
    ["YES", 200_000n, 0n],
    ["NO", 0n, 300_000n],
    ["VOID", 100_000n, 150_000n],
  ] as const)("values approved RESOLVING %s holdings at pending payout without trading fees", (resolution, yes, no) => {
    expect(valueOrderBookPosition({
      market: market({ status: "RESOLVING", resolution, acceptingOrders: false, closesAt: NOW, feeBps: 10_000 }),
      position: position(2, 3),
      orders: [order({ limitPriceMilli: 1n, remainingQuantity: 10 })],
      now: NOW,
    })).toEqual({ yes, no, valueMilli: yes + no, unfilledYes: 0, unfilledNo: 0 });
  });

  it.each([
    [1, 1, 1n, 2n],
    [1, 0, 1n, 0n],
    [0, 1, 0n, 1n],
    [2, 3, 3n, 4n],
  ] as const)("rounds pending VOID payout once for %s YES and %s NO", (yesShares, noShares, yes, no) => {
    expect(valueOrderBookPosition({
      market: market({ status: "RESOLVING", resolution: "VOID", payoutMilli: 3n, acceptingOrders: false }),
      position: position(yesShares, noShares), orders: [], now: NOW,
    })).toEqual({ yes, no, valueMilli: yes + no, unfilledYes: 0, unfilledNo: 0 });
  });

  it("values an already-paid position at zero during partial settlement", () => {
    expect(valueOrderBookPosition({
      market: market({ status: "RESOLVING", resolution: "YES", acceptingOrders: false }),
      position: position(0, 0), orders: [], now: NOW,
    })).toEqual({ yes: 0n, no: 0n, valueMilli: 0n, unfilledYes: 0, unfilledNo: 0 });
  });

  it("attributes odd complete-pair collateral without losing the remainder", () => {
    expect(valueOrderBookPosition({
      market: market({ payoutMilli: 100_001n }),
      position: position(2, 1),
      orders: [],
      now: NOW,
    })).toEqual({ yes: 50_000n, no: 50_001n, valueMilli: 100_001n, unfilledYes: 1, unfilledNo: 0 });
  });

  it("values all holdings after hypothetical cancellation, including shares reserved by an own sell", () => {
    const value = valueOrderBookPosition({
      market: market(),
      position: { ...position(3, 0), reservedYesShares: 2 } as ReturnType<typeof position>,
      orders: [
        order({ userId: "holder", stpOwnerId: "holder", bookSide: "SELL", limitPriceMilli: 80_000n, remainingQuantity: 2 }),
        order({ limitPriceMilli: 60_000n, remainingQuantity: 3 }),
      ],
      now: NOW,
    });

    expect(value).toEqual({ yes: 180_000n, no: 0n, valueMilli: 180_000n, unfilledYes: 0, unfilledNo: 0 });
  });

  it.each([
    { status: "PAUSED", acceptingOrders: true, closesAt: new Date("2026-09-20T12:00:00.000Z") },
    { status: "OPEN", acceptingOrders: false, closesAt: new Date("2026-09-20T12:00:00.000Z") },
    { status: "OPEN", acceptingOrders: true, closesAt: NOW },
  ])("does not imply single-side execution when the market is unavailable: %o", (state) => {
    expect(valueOrderBookPosition({
      market: market(state),
      position: position(2, 1),
      orders: [order({ limitPriceMilli: 90_000n, remainingQuantity: 5 })],
      now: NOW,
    })).toEqual({ yes: 50_000n, no: 50_000n, valueMilli: 100_000n, unfilledYes: 1, unfilledNo: 0 });
  });
});
