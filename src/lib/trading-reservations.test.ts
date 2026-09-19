import { describe, expect, it } from "vitest";

import { ApiError } from "./market-service";
import { availableUnreservedShares, isLmsrMarketOpen } from "./trading";

describe("LMSR sell reservation isolation", () => {
  it("excludes shares already committed to order-book sell orders", () => {
    const position = {
      yesShares: 12,
      noShares: 9,
      reservedYesShares: 7,
      reservedNoShares: 2,
    };

    expect(availableUnreservedShares(position, "YES")).toBe(5);
    expect(availableUnreservedShares(position, "NO")).toBe(7);
  });

  it("treats a fully reserved side as unavailable to the LMSR path", () => {
    expect(availableUnreservedShares({
      yesShares: 10,
      noShares: 0,
      reservedYesShares: 10,
      reservedNoShares: 0,
    }, "YES")).toBe(0);
  });

  it.each([
    { yesShares: 3, noShares: 0, reservedYesShares: 4, reservedNoShares: 0 },
    { yesShares: 3, noShares: 0, reservedYesShares: -1, reservedNoShares: 0 },
  ])("fails closed for inconsistent reservation state", (position) => {
    expect(() => availableUnreservedShares(position, "YES")).toThrow(
      expect.objectContaining<Partial<ApiError>>({
        status: 409,
        code: "POSITION_RECONCILIATION_REQUIRED",
      }),
    );
  });
});

describe("LMSR engine isolation", () => {
  const future = new Date("2030-01-01T00:00:00.000Z");
  const now = new Date("2029-01-01T00:00:00.000Z");

  it("accepts only open, enabled LMSR markets before contractual close", () => {
    expect(isLmsrMarketOpen({
      pricingModel: "LMSR",
      status: "OPEN",
      acceptingOrders: true,
      closesAt: future,
    }, now)).toBe(true);
  });

  it.each([
    { pricingModel: "ORDER_BOOK", status: "OPEN", acceptingOrders: true, closesAt: future },
    { pricingModel: "LMSR", status: "PAUSED", acceptingOrders: true, closesAt: future },
    { pricingModel: "LMSR", status: "OPEN", acceptingOrders: false, closesAt: future },
    { pricingModel: "LMSR", status: "OPEN", acceptingOrders: true, closesAt: now },
  ])("rejects the wrong engine or a non-tradable lifecycle state", (market) => {
    expect(isLmsrMarketOpen(market, now)).toBe(false);
  });
});
