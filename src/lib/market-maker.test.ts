import { describe, expect, it } from "vitest";

import {
  BASIS_POINTS,
  DEFAULT_PAYOUT_MILLI,
  MARKET_MAKER_LIMITS,
  initialSubsidyMilli,
  lmsrCostMilli,
  probabilityBps,
  probabilityYesBps,
  quoteBuy,
  quoteSell,
  requiredCollateralMilli,
  settlementPayoutMilli,
  voidPayoutMilli,
  type MarketMakerState,
  type Outcome,
} from "./market-maker";

const base: MarketMakerState = { yesQuantity: 0, noQuantity: 0, liquidity: 100 };

function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe("LMSR probabilities and cost", () => {
  it("is symmetric at the origin and under swapping outcomes", () => {
    expect(probabilityYesBps(base)).toBe(5_000);
    expect(probabilityBps(base, "YES") + probabilityBps(base, "NO")).toBe(BASIS_POINTS);

    for (let yes = 0; yes <= 1_000; yes += 37) {
      for (let no = 0; no <= 1_000; no += 53) {
        const state = { yesQuantity: yes, noQuantity: no, liquidity: 127 };
        const swapped = { yesQuantity: no, noQuantity: yes, liquidity: 127 };
        expect(probabilityYesBps(state) + probabilityYesBps(swapped)).toBe(BASIS_POINTS);
        expect(lmsrCostMilli(state)).toBe(lmsrCostMilli(swapped));
      }
    }
  });

  it("is invariant to translating both outstanding quantities", () => {
    const state = { yesQuantity: 123, noQuantity: 456, liquidity: 211 };
    const translated = { yesQuantity: 10_123, noQuantity: 10_456, liquidity: 211 };
    expect(probabilityYesBps(translated)).toBe(probabilityYesBps(state));
    const costIncrease = lmsrCostMilli(translated) - lmsrCostMilli(state);
    expect(costIncrease).toBeGreaterThanOrEqual(10_000n * DEFAULT_PAYOUT_MILLI - 1n);
    expect(costIncrease).toBeLessThanOrEqual(10_000n * DEFAULT_PAYOUT_MILLI + 1n);
  });

  it("moves monotonically with relative YES quantity", () => {
    let previous = -1;
    for (let yes = 0; yes <= 2_000; yes += 5) {
      const probability = probabilityYesBps({ yesQuantity: yes, noQuantity: 1_000, liquidity: 250 });
      expect(probability).toBeGreaterThanOrEqual(previous);
      previous = probability;
    }
  });
});

describe("quotes", () => {
  it("moves probability in the selected direction for buys and reverses it for sells", () => {
    for (const outcome of ["YES", "NO"] as const) {
      const buy = quoteBuy(base, outcome, 40);
      if (outcome === "YES") {
        expect(buy.probabilityYesAfterBps).toBeGreaterThan(buy.probabilityYesBeforeBps);
      } else {
        expect(buy.probabilityYesAfterBps).toBeLessThan(buy.probabilityYesBeforeBps);
      }

      const sell = quoteSell(buy.stateAfter, outcome, 40);
      expect(sell.stateAfter).toEqual({ ...base, payoutMilli: DEFAULT_PAYOUT_MILLI });
      expect(sell.probabilityYesAfterBps).toBe(5_000);
    }
  });

  it("never permits round-trip profit, with or without fees", () => {
    const random = rng(0x600d5e);
    for (let i = 0; i < 5_000; i += 1) {
      const liquidity = 100 + Math.floor(random() * 9_901);
      const center = Math.floor(random() * 50_000);
      const spread = Math.floor((random() * 2 - 1) * Math.min(5_000, liquidity * 5));
      const yesQuantity = center + Math.max(spread, 0);
      const noQuantity = center + Math.max(-spread, 0);
      const outcome: Outcome = random() < 0.5 ? "YES" : "NO";
      const selected = outcome === "YES" ? yesQuantity : noQuantity;
      const quantity = 1 + Math.floor(random() * Math.min(2_000, MARKET_MAKER_LIMITS.maxQuantity - selected));
      const feeBps = Math.floor(random() * 101);
      const buy = quoteBuy({ yesQuantity, noQuantity, liquidity }, outcome, quantity, feeBps);
      const sell = quoteSell(buy.stateAfter, outcome, quantity, feeBps);
      expect(sell.netCreditMilli).toBeLessThanOrEqual(buy.totalDebitMilli);
    }
  });

  it("returns mixed-side, partial-sell paths to origin with bounded conservative rounding", () => {
    const random = rng(0x51deba51);
    for (let run = 0; run < 1_000; run += 1) {
      const center = Math.floor(random() * 2_000);
      const initial: MarketMakerState = {
        yesQuantity: center,
        noQuantity: center,
        liquidity: 100 + Math.floor(random() * 900),
      };
      let state = initial;
      let paid = 0n;
      let received = 0n;
      const yesBought = 2 + Math.floor(random() * 50);
      const noBought = 2 + Math.floor(random() * 50);
      const yesFirstSell = 1 + Math.floor(random() * (yesBought - 1));
      const noFirstSell = 1 + Math.floor(random() * (noBought - 1));

      for (const [side, quantity] of [["YES", yesBought], ["NO", noBought]] as const) {
        const quote = quoteBuy(state, side, quantity, 0);
        paid += quote.totalDebitMilli;
        state = quote.stateAfter;
      }
      for (const [side, quantity] of [
        ["YES", yesFirstSell],
        ["NO", noFirstSell],
        ["YES", yesBought - yesFirstSell],
        ["NO", noBought - noFirstSell],
      ] as const) {
        const quote = quoteSell(state, side, quantity, 0);
        received += quote.netCreditMilli;
        state = quote.stateAfter;
      }

      expect(state).toEqual({ ...initial, payoutMilli: DEFAULT_PAYOUT_MILLI });
      const conservativeRoundingLoss = paid - received;
      expect(conservativeRoundingLoss).toBeGreaterThanOrEqual(0n);
      expect(conservativeRoundingLoss).toBeLessThanOrEqual(12n);
    }
  });

  it("makes mixed-side round-trip loss equal fees plus bounded conservative rounding", () => {
    const random = rng(0xfee5ba51);
    for (let run = 0; run < 1_000; run += 1) {
      const center = Math.floor(random() * 500);
      const initial: MarketMakerState = {
        yesQuantity: center,
        noQuantity: center,
        liquidity: 100 + Math.floor(random() * 400),
      };
      const feeBps = 1 + Math.floor(random() * 500);
      const yesQuantity = 1 + Math.floor(random() * 40);
      const noQuantity = 1 + Math.floor(random() * 40);
      let state = initial;
      let debit = 0n;
      let credit = 0n;
      let fees = 0n;
      let grossBought = 0n;
      let grossSold = 0n;

      for (const [side, quantity] of [["YES", yesQuantity], ["NO", noQuantity]] as const) {
        const quote = quoteBuy(state, side, quantity, feeBps);
        debit += quote.totalDebitMilli;
        fees += quote.feeMilli;
        grossBought += quote.grossMilli;
        state = quote.stateAfter;
      }
      for (const [side, quantity] of [["NO", noQuantity], ["YES", yesQuantity]] as const) {
        const quote = quoteSell(state, side, quantity, feeBps);
        credit += quote.netCreditMilli;
        fees += quote.feeMilli;
        grossSold += quote.grossMilli;
        state = quote.stateAfter;
      }

      expect(state).toEqual({ ...initial, payoutMilli: DEFAULT_PAYOUT_MILLI });
      const conservativeRoundingLoss = grossBought - grossSold;
      expect(conservativeRoundingLoss).toBeGreaterThanOrEqual(0n);
      expect(conservativeRoundingLoss).toBeLessThanOrEqual(8n);
      expect(debit - credit).toBe(fees + conservativeRoundingLoss);
    }
  });

  it("charges increasing marginal cost for repeated buys", () => {
    let state = base;
    let prior = 0n;
    for (let i = 0; i < 100; i += 1) {
      const quote = quoteBuy(state, "YES", 1);
      expect(quote.grossMilli).toBeGreaterThanOrEqual(prior);
      prior = quote.grossMilli;
      state = quote.stateAfter;
    }
  });

  it("uses exact integer fee arithmetic and conservative averages", () => {
    const buy = quoteBuy(base, "YES", 7, 125);
    expect(buy.feeMilli).toBe((buy.grossMilli * 125n + 9_999n) / 10_000n);
    expect(buy.totalDebitMilli).toBe(buy.grossMilli + buy.feeMilli);
    expect(buy.averagePriceMilli * 7n).toBeGreaterThanOrEqual(buy.grossMilli);

    const sell = quoteSell(buy.stateAfter, "YES", 7, 125);
    expect(sell.averagePriceMilli * 7n).toBeLessThanOrEqual(sell.grossMilli);
  });
});

describe("collateral and settlement", () => {
  it("computes exact winning and deterministic void payouts", () => {
    expect(settlementPayoutMilli(17)).toBe(1_700_000n);
    expect(voidPayoutMilli(17)).toBe(850_000n);
    expect(voidPayoutMilli(3, 101n)).toBe(151n);
  });

  it("initial subsidy plus conservative trade cashflows always covers worst-case resolution", () => {
    const random = rng(0xc011a7e);
    for (let run = 0; run < 100; run += 1) {
      let state: MarketMakerState = {
        yesQuantity: 0,
        noQuantity: 0,
        liquidity: 1 + Math.floor(random() * 5_000),
      };
      let collateral = initialSubsidyMilli(state.liquidity);

      for (let step = 0; step < 100; step += 1) {
        const outcome: Outcome = random() < 0.5 ? "YES" : "NO";
        const selected = outcome === "YES" ? state.yesQuantity : state.noQuantity;
        const canSell = selected > 0 && random() < 0.4;
        const quantity = canSell
          ? 1 + Math.floor(random() * Math.min(selected, 30))
          : 1 + Math.floor(random() * 30);
        const quote = canSell
          ? quoteSell(state, outcome, quantity)
          : quoteBuy(state, outcome, quantity);
        collateral += canSell ? -quote.grossMilli : quote.grossMilli;
        state = quote.stateAfter;
        expect(collateral).toBeGreaterThanOrEqual(requiredCollateralMilli(state));
      }
    }
  });
});

describe("validation and extreme supported inputs", () => {
  it("remains finite and bounded at every configured maximum", () => {
    const extreme = {
      yesQuantity: MARKET_MAKER_LIMITS.maxQuantity,
      noQuantity: 0,
      liquidity: MARKET_MAKER_LIMITS.maxLiquidity,
      payoutMilli: MARKET_MAKER_LIMITS.maxPayoutMilli,
    };
    expect(probabilityYesBps(extreme)).toBeGreaterThan(9_999);
    expect(lmsrCostMilli(extreme)).toBeGreaterThan(0n);
    expect(quoteSell(extreme, "YES", MARKET_MAKER_LIMITS.maxQuantity).grossMilli).toBeGreaterThan(0n);
    expect(initialSubsidyMilli(MARKET_MAKER_LIMITS.maxLiquidity, MARKET_MAKER_LIMITS.maxPayoutMilli)).toBeGreaterThan(0n);
  });

  it.each([
    [{ yesQuantity: -1, noQuantity: 0, liquidity: 1 }, "negative quantity"],
    [{ yesQuantity: 0.5, noQuantity: 0, liquidity: 1 }, "fractional quantity"],
    [{ yesQuantity: 0, noQuantity: 0, liquidity: 0 }, "zero liquidity"],
    [{ yesQuantity: Number.NaN, noQuantity: 0, liquidity: 1 }, "NaN"],
    [{ yesQuantity: Number.POSITIVE_INFINITY, noQuantity: 0, liquidity: 1 }, "infinity"],
  ])("rejects invalid state: %s", (state) => {
    expect(() => probabilityYesBps(state as MarketMakerState)).toThrow();
  });

  it("rejects invalid trades and monetary types", () => {
    expect(() => quoteBuy(base, "YES", 0)).toThrow();
    expect(() => quoteBuy(base, "YES", 1.5)).toThrow();
    expect(() => quoteSell(base, "YES", 1)).toThrow();
    expect(() => quoteBuy(base, "MAYBE" as Outcome, 1)).toThrow();
    expect(() => quoteBuy(base, "YES", 1, -1)).toThrow();
    expect(() => initialSubsidyMilli(1, 1 as unknown as bigint)).toThrow();
  });
});
