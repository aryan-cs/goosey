import { describe, expect, it } from "vitest";

import {
  calculateOrderReservation,
  classifyFillEconomics,
  cumulativeFeeDeltaMilli,
  cumulativeFeeMilli,
  planFillJournal,
  sumJournalPostings,
  type FillJournalInput,
  type OrderIntent,
} from "./order-book-accounting";

const PAYOUT = 100_000n;
const buyYes: OrderIntent = { outcome: "YES", action: "BUY" };
const sellYes: OrderIntent = { outcome: "YES", action: "SELL" };
const buyNo: OrderIntent = { outcome: "NO", action: "BUY" };
const sellNo: OrderIntent = { outcome: "NO", action: "SELL" };

describe("CLOB reservations", () => {
  it("reserves buy principal plus the worst possible execution fee", () => {
    expect(calculateOrderReservation({
      ...buyYes,
      limitPriceMilli: 40_000n,
      quantity: 10n,
      payoutMilli: PAYOUT,
      makerFeeBps: 25n,
      takerFeeBps: 100n,
    })).toEqual({
      principalMilli: 400_000n,
      maximumFeeMilli: 4_000n,
      cashReserveMilli: 404_000n,
      shareReserve: null,
      worstCaseFeeBps: 100n,
    });
  });

  it("uses maker fees for post-only orders and reserves contracts for sells", () => {
    const postOnly = calculateOrderReservation({
      ...buyNo,
      limitPriceMilli: 60_000n,
      quantity: 5n,
      payoutMilli: PAYOUT,
      makerFeeBps: 20n,
      takerFeeBps: 80n,
      postOnly: true,
    });
    expect(postOnly.cashReserveMilli).toBe(300_600n);
    expect(postOnly.worstCaseFeeBps).toBe(20n);

    const sell = calculateOrderReservation({
      ...sellNo,
      limitPriceMilli: 55_000n,
      quantity: 7n,
      payoutMilli: PAYOUT,
      makerFeeBps: 20n,
      takerFeeBps: 80n,
    });
    expect(sell.cashReserveMilli).toBe(0n);
    expect(sell.shareReserve).toEqual({ outcome: "NO", quantity: 7n });
    expect(sell.maximumFeeMilli).toBe(5_600n);
  });
});

describe("cumulative fees", () => {
  it("is invariant to fill splitting, including sub-unit rounding", () => {
    const notionals = [1n, 1n, 1n, 17_999n, 161_998n];
    let cumulative = 0n;
    let charged = 0n;
    for (const fillNotionalMilli of notionals) {
      charged += cumulativeFeeDeltaMilli({
        previousExecutedNotionalMilli: cumulative,
        fillNotionalMilli,
        feeBps: 100n,
      });
      cumulative += fillNotionalMilli;
    }
    expect(charged).toBe(cumulativeFeeMilli(cumulative, 100n));
    expect(charged).toBe(1_800n);

    expect(cumulativeFeeDeltaMilli({
      previousExecutedNotionalMilli: 0n,
      fillNotionalMilli: 1n,
      feeBps: 1n,
    })).toBe(1n);
    expect(cumulativeFeeDeltaMilli({
      previousExecutedNotionalMilli: 1n,
      fillNotionalMilli: 1n,
      feeBps: 1n,
    })).toBe(0n);
  });
});

describe("fill economic classification", () => {
  it.each([
    [buyYes, buyNo, "MINT"],
    [sellYes, sellNo, "BURN"],
    [buyYes, sellYes, "TRANSFER_YES"],
    [buyNo, sellNo, "TRANSFER_NO"],
  ] as const)("classifies %o plus %o as %s in either maker/taker order", (first, second, expected) => {
    expect(classifyFillEconomics(first, second)).toBe(expected);
    expect(classifyFillEconomics(second, first)).toBe(expected);
  });

  it("rejects intents that cannot cross on the canonical book", () => {
    expect(() => classifyFillEconomics(buyYes, sellNo)).toThrow(/opposite canonical/);
    expect(() => classifyFillEconomics(sellYes, buyNo)).toThrow(/opposite canonical/);
  });
});

describe("fill journal plans", () => {
  const base: Omit<FillJournalInput, "maker" | "taker"> = {
    canonicalYesPriceMilli: 40_000n,
    quantity: 5n,
    payoutMilli: PAYOUT,
    makerFeeMilli: 200n,
    takerFeeMilli: 300n,
  };

  it.each([
    {
      maker: buyNo,
      taker: buyYes,
      kind: "MINT",
      expected: [
        ["MAKER", "RESERVED_CASH", -300_200n],
        ["TAKER", "RESERVED_CASH", -200_300n],
        ["MARKET", "COLLATERAL", 500_000n],
        ["PROTOCOL", "REVENUE", 500n],
      ],
    },
    {
      maker: sellYes,
      taker: sellNo,
      kind: "BURN",
      expected: [
        ["MARKET", "COLLATERAL", -500_000n],
        ["MAKER", "AVAILABLE_CASH", 199_800n],
        ["TAKER", "AVAILABLE_CASH", 299_700n],
        ["PROTOCOL", "REVENUE", 500n],
      ],
    },
    {
      maker: sellYes,
      taker: buyYes,
      kind: "TRANSFER_YES",
      expected: [
        ["MAKER", "AVAILABLE_CASH", 199_800n],
        ["TAKER", "RESERVED_CASH", -200_300n],
        ["PROTOCOL", "REVENUE", 500n],
      ],
    },
    {
      maker: sellNo,
      taker: buyNo,
      kind: "TRANSFER_NO",
      expected: [
        ["MAKER", "AVAILABLE_CASH", 299_800n],
        ["TAKER", "RESERVED_CASH", -300_300n],
        ["PROTOCOL", "REVENUE", 500n],
      ],
    },
  ] as const)("creates an exact balanced $kind journal", ({ maker, taker, kind, expected }) => {
    const plan = planFillJournal({ ...base, maker, taker });
    expect(plan.economicKind).toBe(kind);
    expect(plan.yesPrincipalMilli).toBe(200_000n);
    expect(plan.noPrincipalMilli).toBe(300_000n);
    expect(plan.postings.map(({ owner, bucket, amountMilli }) => [owner, bucket, amountMilli])).toEqual(expected);
    expect(sumJournalPostings(plan.postings)).toBe(0n);
  });

  it("rejects a seller fee larger than its proceeds", () => {
    expect(() => planFillJournal({
      ...base,
      maker: sellYes,
      taker: buyYes,
      makerFeeMilli: 200_001n,
    })).toThrow(/fee cannot exceed sale proceeds/);
  });
});
