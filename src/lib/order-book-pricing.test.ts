import { describe, expect, it } from "vitest";

import {
  aggregatePriceLevels,
  bestBidAsk,
  effectiveRoundTripSpreadBps,
  impliedProbabilityBps,
  quotedSpreadBps,
  selectMarketMark,
  sweepPriceLevels,
} from "./order-book-pricing";

const PAYOUT = 100_000n;

describe("order-book level aggregation and depth", () => {
  it("aggregates duplicate prices and sorts each side best first", () => {
    const levels = [
      { priceMilli: 42_000n, quantity: 2n },
      { priceMilli: 40_000n, quantity: 3n },
      { priceMilli: 42_000n, quantity: 5n },
    ];

    expect(aggregatePriceLevels(levels, "BID", PAYOUT)).toEqual([
      { priceMilli: 42_000n, quantity: 7n },
      { priceMilli: 40_000n, quantity: 3n },
    ]);
    expect(aggregatePriceLevels(levels, "ASK", PAYOUT)).toEqual([
      { priceMilli: 40_000n, quantity: 3n },
      { priceMilli: 42_000n, quantity: 7n },
    ]);
  });

  it("finds top-of-book and preserves sparse sides", () => {
    expect(
      bestBidAsk(
        [{ priceMilli: 41_000n, quantity: 2n }],
        [{ priceMilli: 44_000n, quantity: 1n }],
        PAYOUT,
      ),
    ).toEqual({
      bestBid: { priceMilli: 41_000n, quantity: 2n },
      bestAsk: { priceMilli: 44_000n, quantity: 1n },
      spreadMilli: 3_000n,
    });
    expect(bestBidAsk([{ priceMilli: 41_000n, quantity: 2n }], [], PAYOUT)).toEqual({
      bestBid: { priceMilli: 41_000n, quantity: 2n },
      bestAsk: null,
      spreadMilli: null,
    });
  });

  it("sweeps exact depth with conservative buy and sell averages", () => {
    const buy = sweepPriceLevels(
      [
        { priceMilli: 42_000n, quantity: 2n },
        { priceMilli: 43_001n, quantity: 3n },
      ],
      "ASK",
      4n,
      PAYOUT,
    );
    expect(buy).toEqual({
      requestedQuantity: 4n,
      filledQuantity: 4n,
      unfilledQuantity: 0n,
      grossMilli: 170_002n,
      averagePriceMilli: 42_501n,
      worstPriceMilli: 43_001n,
      fullyFillable: true,
      fills: [
        { priceMilli: 42_000n, quantity: 2n },
        { priceMilli: 43_001n, quantity: 2n },
      ],
    });

    const sell = sweepPriceLevels(
      [
        { priceMilli: 41_001n, quantity: 2n },
        { priceMilli: 40_000n, quantity: 1n },
      ],
      "BID",
      4n,
      PAYOUT,
    );
    expect(sell.filledQuantity).toBe(3n);
    expect(sell.unfilledQuantity).toBe(1n);
    expect(sell.grossMilli).toBe(122_002n);
    expect(sell.averagePriceMilli).toBe(40_667n);
    expect(sell.worstPriceMilli).toBe(40_000n);
    expect(sell.fullyFillable).toBe(false);
  });
});

describe("probability and spreads", () => {
  it("uses integer-only rounded probability and spread calculations", () => {
    expect(impliedProbabilityBps(42_345n, PAYOUT)).toBe(4_235n);
    expect(impliedProbabilityBps(0n, PAYOUT)).toBe(0n);
    expect(impliedProbabilityBps(PAYOUT, PAYOUT)).toBe(10_000n);
    expect(quotedSpreadBps(3_005n, PAYOUT)).toBe(301n);
  });

  it("computes depth-aware round-trip spread only when both sides fill", () => {
    const bids = [{ priceMilli: 40_000n, quantity: 3n }];
    const asks = [{ priceMilli: 44_000n, quantity: 3n }];
    expect(effectiveRoundTripSpreadBps(bids, asks, 2n, PAYOUT)).toBe(400n);
    expect(effectiveRoundTripSpreadBps(bids, asks, 4n, PAYOUT)).toBeNull();
  });
});

describe("display marks", () => {
  const nowMs = 10_000_000n;

  it("uses a qualified midpoint and rounds an odd midpoint upward", () => {
    const mark = selectMarketMark({
      bids: [{ priceMilli: 42_000n, quantity: 2n }],
      asks: [{ priceMilli: 43_001n, quantity: 3n }],
      payoutMilli: PAYOUT,
      nowMs,
      lastTrade: { priceMilli: 39_000n, executedAtMs: nowMs - 1n },
    });
    expect(mark.displayPriceMilli).toBe(42_501n);
    expect(mark.displayProbabilityBps).toBe(4_250n);
    expect(mark.source).toBe("MID");
    expect(mark.stale).toBe(false);
    expect(mark.spreadMilli).toBe(1_001n);
  });

  it("falls back to the last trade for wide, crossed, or underqualified books", () => {
    for (const [bids, asks] of [
      [[{ priceMilli: 30_000n, quantity: 2n }], [{ priceMilli: 50_001n, quantity: 2n }]],
      [[{ priceMilli: 55_000n, quantity: 2n }], [{ priceMilli: 50_000n, quantity: 2n }]],
      [[{ priceMilli: 40_000n, quantity: 1n }], [{ priceMilli: 42_000n, quantity: 2n }]],
    ] as const) {
      const mark = selectMarketMark({
        bids,
        asks,
        payoutMilli: PAYOUT,
        nowMs,
        minimumTopLevelQuantity: 2n,
        lastTrade: { priceMilli: 47_000n, executedAtMs: nowMs - 3_600_001n },
      });
      expect(mark.displayPriceMilli).toBe(47_000n);
      expect(mark.source).toBe("LAST");
      expect(mark.stale).toBe(true);
    }
  });

  it("does not invent a point estimate for sparse or empty books", () => {
    const bidOnly = selectMarketMark({
      bids: [{ priceMilli: 42_000n, quantity: 1n }],
      asks: [],
      payoutMilli: PAYOUT,
      nowMs,
    });
    expect(bidOnly).toMatchObject({
      displayPriceMilli: null,
      displayProbabilityBps: null,
      source: "NONE",
      bestBidMilli: 42_000n,
      bestAskMilli: null,
      spreadMilli: null,
    });

    const empty = selectMarketMark({ bids: [], asks: [], payoutMilli: PAYOUT, nowMs });
    expect(empty.source).toBe("NONE");
    expect(empty.displayPriceMilli).toBeNull();
  });

  it("gives a terminal settlement mark precedence and never marks it stale", () => {
    const mark = selectMarketMark({
      bids: [{ priceMilli: 45_000n, quantity: 10n }],
      asks: [{ priceMilli: 46_000n, quantity: 10n }],
      payoutMilli: PAYOUT,
      nowMs,
      lastTrade: { priceMilli: 44_000n, executedAtMs: 0n },
      settlementPriceMilli: PAYOUT,
    });
    expect(mark).toMatchObject({
      displayPriceMilli: PAYOUT,
      displayProbabilityBps: 10_000n,
      source: "SETTLEMENT",
      stale: false,
    });
  });
});

describe("input validation", () => {
  it("rejects invalid quantities, prices, and clocks", () => {
    expect(() => sweepPriceLevels([], "ASK", 0n, PAYOUT)).toThrow(RangeError);
    expect(() => aggregatePriceLevels([{ priceMilli: 10n, quantity: 0n }], "BID", PAYOUT)).toThrow(
      RangeError,
    );
    expect(() => impliedProbabilityBps(PAYOUT + 1n, PAYOUT)).toThrow(RangeError);
    expect(() => selectMarketMark({ bids: [], asks: [], payoutMilli: PAYOUT, nowMs: -1n })).toThrow(
      RangeError,
    );
  });
});
