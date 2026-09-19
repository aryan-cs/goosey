import { describe, expect, it } from "vitest";

import { ORDER_BOOK_LIMITS } from "./order-book";
import { orderEntryHref, parseOrderEntry } from "./order-entry";

const PAYOUT = 100_000n;

describe("order entry parsing", () => {
  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-integer quantity %s without throwing",
    (quantity) => expect(parseOrderEntry("40.000", quantity, PAYOUT, 100, "BUY")).toMatchObject({ valid: false }),
  );

  it.each([ORDER_BOOK_LIMITS.maxQuantity + 1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects quantity above the engine bound: %s",
    (quantity) => expect(parseOrderEntry("40.000", quantity, PAYOUT, 100, "BUY")).toMatchObject({ valid: false }),
  );

  it.each(["1e2", "1E2", "+1.000", " 1.000", ".500", "1.", "1.0000", "01.000"])(
    "rejects non-canonical decimal price %s",
    (price) => expect(parseOrderEntry(price, 1, PAYOUT, 100, "BUY")).toMatchObject({ valid: false }),
  );

  it.each(["0", "0.000", "100", "100.000", "101.000"])(
    "rejects price outside the binary payout range: %s",
    (price) => expect(parseOrderEntry(price, 1, PAYOUT, 100, "BUY")).toMatchObject({ valid: false }),
  );

  it("uses the supplied payout instead of assuming 100 feathers", () => {
    expect(parseOrderEntry("49.999", 1, 50_000n, 0, "BUY")).toEqual({
      valid: true,
      priceMilli: 49_999n,
      grossMilli: 49_999n,
      feeMilli: 0n,
      cashMilli: 49_999n,
    });
    expect(parseOrderEntry("50.000", 1, 50_000n, 0, "BUY")).toMatchObject({ valid: false });
  });

  it("parses one milli-feather exactly without floating point", () => {
    expect(parseOrderEntry("0.001", 3, PAYOUT, 0, "BUY")).toEqual({
      valid: true,
      priceMilli: 1n,
      grossMilli: 3n,
      feeMilli: 0n,
      cashMilli: 3n,
    });
  });

  it("rounds the cumulative fee upward exactly once", () => {
    expect(parseOrderEntry("0.001", 2, PAYOUT, 1, "BUY")).toEqual({
      valid: true,
      priceMilli: 1n,
      grossMilli: 2n,
      feeMilli: 1n,
      cashMilli: 3n,
    });
  });

  it("adds fees to BUY reserves and subtracts them from SELL proceeds", () => {
    expect(parseOrderEntry("1.000", 2, PAYOUT, 1_000, "BUY")).toMatchObject({
      valid: true,
      grossMilli: 2_000n,
      feeMilli: 200n,
      cashMilli: 2_200n,
    });
    expect(parseOrderEntry("1.000", 2, PAYOUT, 1_000, "SELL")).toMatchObject({
      valid: true,
      grossMilli: 2_000n,
      feeMilli: 200n,
      cashMilli: 1_800n,
    });
  });

  it.each([
    { payout: 0n, fee: 0 },
    { payout: ORDER_BOOK_LIMITS.maxPayoutMilli + 1n, fee: 0 },
    { payout: PAYOUT, fee: -1 },
    { payout: PAYOUT, fee: 10_001 },
    { payout: PAYOUT, fee: 1.5 },
  ])("rejects invalid market bounds without throwing: %o", ({ payout, fee }) => {
    expect(parseOrderEntry("1.000", 1, payout, fee, "BUY")).toMatchObject({ valid: false });
  });
});

describe("order entry links", () => {
  it("builds a local encoded market destination with ticket state", () => {
    expect(orderEntryHref("venue wifi/2026", "NO", "BUY")).toBe(
      "/markets/venue%20wifi%2F2026?outcome=NO&action=BUY#order-book",
    );
  });
});
