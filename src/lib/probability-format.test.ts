import { describe, expect, it } from "vitest";
import {
  complementaryWholePercents,
  probabilityBpsToWholePercent,
  probabilityFractionLabel,
  probabilityFractionToBps,
  probabilityMovementPoints,
} from "./probability-format";

describe("probability display precision", () => {
  it.each([
    [0, 0],
    [49, 0],
    [50, 1],
    [1_450, 15],
    [2_850, 29],
    [4_999, 50],
    [5_000, 50],
    [5_050, 51],
    [5_650, 57],
    [5_750, 58],
    [9_999, 100],
    [10_000, 100],
  ])("rounds %i bps to %i%% with integer half-up semantics", (bps, expected) =>
    expect(probabilityBpsToWholePercent(bps)).toBe(expected),
  );

  it("keeps displayed YES and NO complementary for every valid basis-point value", () => {
    for (let bps = 0; bps <= 10_000; bps++) {
      const result = complementaryWholePercents(bps);
      expect(result.yes + result.no).toBe(100);
      expect(probabilityFractionLabel(bps / 10_000)).toBe(`${result.yes}%`);
    }
  });

  it.each([-1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid basis-point input %s instead of displaying a misleading probability",
    (bps) => expect(() => probabilityBpsToWholePercent(bps)).toThrow("probability bps"),
  );

  it("rounds movements to whole probability points without losing the sign", () => {
    expect(probabilityMovementPoints(5_000, 5_049)).toBe(0);
    expect(probabilityMovementPoints(5_000, 5_050)).toBe(1);
    expect(probabilityMovementPoints(5_000, 4_950)).toBe(-1);
    expect(probabilityMovementPoints(6_250, 4_900)).toBe(-14);
  });

  it("normalizes fractions through integer basis points before display", () => {
    expect(probabilityFractionToBps(0)).toBe(0);
    expect(probabilityFractionToBps(0.51234)).toBe(5_123);
    expect(probabilityFractionToBps(0.99999)).toBe(10_000);
    expect(probabilityFractionLabel(0.51234)).toBe("51%");
  });

  it.each([-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid probability fraction %s",
    (probability) => expect(() => probabilityFractionToBps(probability)).toThrow(RangeError),
  );
});
