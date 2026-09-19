import { describe, expect, it } from "vitest";
import { tradePayoutMilli, validTradeQuantity } from "./trade-quantity";

describe("trade quantity safety", () => {
  it.each([1.5, 0, -1, NaN, Infinity, -Infinity, 100_001, 1e100, Number.MAX_SAFE_INTEGER + 1])("rejects %s without throwing during payout rendering", (quantity) => {
    expect(validTradeQuantity(quantity)).toBe(false);
    expect(tradePayoutMilli(quantity)).toBe(0n);
  });
  it.each([1, 100, 100_000, Number("1e3")])("accepts in-range whole quantities including numeric exponent input: %s", (quantity) => {
    expect(validTradeQuantity(quantity)).toBe(true);
    expect(tradePayoutMilli(quantity)).toBe(BigInt(quantity) * 100_000n);
  });
});
