import { describe, expect, it } from "vitest";
import { positionSettlementPayoutMilli } from "./settlement-payout";

describe("position settlement payouts", () => {
  it("settles each winning side without paying losing shares", () => {
    expect(positionSettlementPayoutMilli({ yesShares: 3, noShares: 7 }, "YES", 100_000n)).toBe(300_000n);
    expect(positionSettlementPayoutMilli({ yesShares: 3, noShares: 7 }, "NO", 100_000n)).toBe(700_000n);
  });
  it.each(["YES", "NO"])("validates the losing side before returning a %s payout", (outcome) => {
    expect(positionSettlementPayoutMilli({ yesShares: 10_000_000, noShares: 10_000_000 }, outcome, 100_000n))
      .toBe(1_000_000_000_000n);
    for (const quantity of [-1, 0.5, 10_000_001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const position = outcome === "YES"
        ? { yesShares: 1, noShares: quantity }
        : { yesShares: quantity, noShares: 1 };
      expect(() => positionSettlementPayoutMilli(position, outcome, 100_000n)).toThrow(RangeError);
    }
  });
  it("voids valid two-sided positions whose combined quantity exceeds one-side capacity", () => {
    expect(positionSettlementPayoutMilli({ yesShares: 6_000_000, noShares: 6_000_000 }, "VOID", 100_000n)).toBe(600_000_000_000n);
    expect(positionSettlementPayoutMilli({ yesShares: 10_000_000, noShares: 10_000_000 }, "VOID", 100_000n)).toBe(1_000_000_000_000n);
  });
  it("rounds an indivisible legacy payout once per whole position", () => {
    expect(positionSettlementPayoutMilli({ yesShares: 1, noShares: 1 }, "VOID", 3n)).toBe(3n);
    expect(positionSettlementPayoutMilli({ yesShares: 1, noShares: 0 }, "VOID", 3n)).toBe(1n);
  });
  it.each([-1, 0.5, 10_000_001, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid per-outcome quantity %s", (quantity) => {
    expect(() => positionSettlementPayoutMilli({ yesShares: quantity, noShares: 0 }, "VOID", 100_000n)).toThrow();
    expect(() => positionSettlementPayoutMilli({ yesShares: 0, noShares: quantity }, "VOID", 100_000n)).toThrow();
  });
  it("rejects invalid payout and resolution values", () => {
    expect(() => positionSettlementPayoutMilli({ yesShares: 1, noShares: 1 }, "VOID", 0n)).toThrow();
    expect(() => positionSettlementPayoutMilli({ yesShares: 1, noShares: 1 }, "UNKNOWN", 100_000n)).toThrow();
  });
});
