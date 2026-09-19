import { describe, expect, it } from "vitest";

import { formatFeathers } from "./feather-format";

describe("formatFeathers", () => {
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
