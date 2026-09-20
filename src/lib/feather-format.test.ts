import { describe, expect, it } from "vitest";

import { formatFeathers } from "./feather-format";

describe("formatFeathers", () => {
  it.each([
    [0n, "0"],
    [499n, "0"],
    [500n, "1"],
    [1_499n, "1"],
    [1_500n, "2"],
    [999_499n, "999"],
    [999_500n, "1,000"],
    [-499n, "0"],
    [-500n, "-1"],
    [-1_499n, "-1"],
    [-1_500n, "-2"],
  ])("rounds %s milli-feathers to the nearest whole feather as %s", (milli, expected) => {
    expect(formatFeathers(milli)).toBe(expected);
  });

  it("rounds and groups values beyond Number safe integer precision without converting to Number", () => {
    expect(formatFeathers(9_007_199_254_740_993_499n)).toBe("9,007,199,254,740,993");
    expect(formatFeathers(9_007_199_254_740_993_500n)).toBe("9,007,199,254,740,994");
    expect(formatFeathers(-9_007_199_254_740_993_500n)).toBe("-9,007,199,254,740,994");
  });

  it("rounds milli-feathers consistently at the requested display precision", () => {
    expect(formatFeathers(999_999n, 2)).toBe("1,000");
    expect(formatFeathers(999_994n, 2)).toBe("999.99");
    expect(formatFeathers(610_501n, 2)).toBe("610.5");
    expect(formatFeathers(-1_235n, 2)).toBe("-1.24");
  });

  it("formats balances beyond Number safe integer precision without losing milli-feathers", () => {
    expect(formatFeathers(9_007_199_254_740_993n, 3)).toBe("9,007,199,254,740.993");
  });

  it("rejects precision that exceeds stored milli-feathers", () => {
    expect(() => formatFeathers(1n, 4)).toThrow("maximumFractionDigits");
  });
});
