import { describe, expect, it } from "vitest";

import { buyOrderReserve, orderCashDeficit } from "./order-reserve";

describe("managed order reserve policy", () => {
  it("matches full-limit principal and ceiling fee accounting", () => {
    expect(buyOrderReserve({ limitPriceMilli: 501n, quantity: 3n, feeBps: 10 }))
      .toEqual({ principal: 1_503n, fee: 2n, requiredCash: 1_505n });
    expect(buyOrderReserve({ limitPriceMilli: 1n, quantity: 1n, feeBps: 1 }))
      .toEqual({ principal: 1n, fee: 1n, requiredCash: 2n });
    expect(buyOrderReserve({ limitPriceMilli: 500n, quantity: 2n, feeBps: 0 }))
      .toEqual({ principal: 1_000n, fee: 0n, requiredCash: 1_000n });
  });

  it("deposits only the exact BUY deficit and never cash-funds SELL orders", () => {
    const base = { limitPriceMilli: 500n, quantity: 2n, feeBps: 100 };
    expect(orderCashDeficit({ ...base, action: "BUY", availableCash: 800n })).toBe(210n);
    expect(orderCashDeficit({ ...base, action: "BUY", availableCash: 1_010n })).toBe(0n);
    expect(orderCashDeficit({ ...base, action: "BUY", availableCash: 5_000n })).toBe(0n);
    expect(orderCashDeficit({ ...base, action: "SELL", availableCash: 0n })).toBe(0n);
  });

  it.each([
    { limitPriceMilli: 0n, quantity: 1n, feeBps: 1 },
    { limitPriceMilli: 1n, quantity: 0n, feeBps: 1 },
    { limitPriceMilli: 1n, quantity: 1n, feeBps: -1 },
    { limitPriceMilli: 1n, quantity: 1n, feeBps: 10_001 },
    { limitPriceMilli: 1n << 64n, quantity: 1n, feeBps: 1 },
    { limitPriceMilli: (1n << 64n) - 1n, quantity: 2n, feeBps: 0 },
    { limitPriceMilli: (1n << 64n) - 1n, quantity: 1n, feeBps: 1 },
  ])("rejects invalid or overflowing reserve %#", value => {
    expect(() => buyOrderReserve(value)).toThrow();
  });

  it("rejects invalid finalized available cash", () => {
    expect(() => orderCashDeficit({ action: "BUY", limitPriceMilli: 1n, quantity: 1n,
      feeBps: 0, availableCash: -1n })).toThrow("available escrow cash");
  });
});

