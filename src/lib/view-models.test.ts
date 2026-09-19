import type { Market } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { marketProbabilityBps, marketSummary } from "./view-models";

const market = { id: "book", slug: "book", title: "Campus prediction", category: "Campus", pricingModel: "ORDER_BOOK", status: "OPEN", resolution: null, closesAt: new Date("2099-01-01"), yesShares: 10, noShares: 10, payoutMilli: 100_000n, liquidityParameter: 100, volumeMilli: 0n, commentCount: 0 } as Market;

describe("market presentation marks", () => {
  it("does not turn equal order-book inventories into a synthetic 50% price", () => {
    expect(marketProbabilityBps(market)).toBeNull();
    const summary = marketSummary(market);
    expect(summary.outcomes.map((outcome) => outcome.probability)).toEqual([null, null]);
    expect(summary.outcomes[0]!.change).toBeUndefined();
    expect(summary.sparkline).toEqual([]);
  });
  it("uses the supplied real mark and execution history", () => {
    const summary = marketSummary({ ...market, orderFills: [
      { canonicalYesPriceMilli: 30_000n, createdAt: new Date("2026-09-19T12:01:00Z") },
      { canonicalYesPriceMilli: 40_000n, createdAt: new Date("2026-09-19T12:00:00Z") },
    ] }, 3000);
    expect(summary.outcomes.map((outcome) => outcome.probability)).toEqual([0.3, 0.7]);
    expect(summary.sparkline?.map((point) => point.probability)).toEqual([0.4, 0.3]);
    expect(summary.outcomes[0]!.change).toBe(-10);
  });
  it("preserves LMSR and terminal forecasts", () => {
    expect(marketProbabilityBps({ ...market, pricingModel: "LMSR" })).toBe(5000);
    expect(marketProbabilityBps({ ...market, status: "RESOLVED", resolution: "YES" })).toBe(10000);
    expect(marketProbabilityBps({ ...market, status: "RESOLVED", resolution: "NO" })).toBe(0);
    expect(marketProbabilityBps({ ...market, status: "VOID" })).toBe(5000);
  });
});
