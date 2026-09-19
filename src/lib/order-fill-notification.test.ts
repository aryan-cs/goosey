import { describe, expect, it } from "vitest";
import { notificationFeathers, orderFillNotification } from "./order-fill-notification";

const base = {
  userId: "participant",
  quantity: 3,
  canonicalYesPriceMilli: 38_125n,
  payoutMilli: 100_000n,
  feeMilli: 1_005n,
  marketSlug: "campus-market",
  marketTitle: "Campus market",
  executedAt: new Date("2026-09-19T14:00:00Z"),
};

describe("order fill notification", () => {
  it("formats legacy average prices in feathers without losing milli precision", () => {
    expect(notificationFeathers(55_106n)).toBe("55.106");
    expect(notificationFeathers(0n)).toBe("0");
    expect(notificationFeathers(9_007_199_254_740_993n)).toBe("9007199254740.993");
  });
  it.each([
    ["YES", "BUY", "Bought 3 YES", "38.125"],
    ["NO", "BUY", "Bought 3 NO", "61.875"],
    ["YES", "SELL", "Sold 3 YES", "38.125"],
    ["NO", "SELL", "Sold 3 NO", "61.875"],
  ] as const)("describes %s %s in participant-side feathers", (outcome, action, title, price) => {
    expect(orderFillNotification({ ...base, intent: { outcome, action } })).toEqual({
      userId: base.userId, type: "TRADE_CONFIRMED", title,
      body: `Campus market: filled at ${price} feathers per contract. Fee: 1.005 feathers.`,
      href: "/markets/campus-market", createdAt: base.executedAt,
    });
  });

  it("formats whole and sub-feather values without rounding", () => {
    const notice = orderFillNotification({ ...base, intent: { outcome: "YES", action: "BUY" }, canonicalYesPriceMilli: 40_000n, feeMilli: 1n });
    expect(notice.body).toContain("40 feathers per contract. Fee: 0.001 feathers.");
  });

  it("uses the market payout rather than assuming 100 feathers", () => {
    const notice = orderFillNotification({ ...base, intent: { outcome: "NO", action: "SELL" }, payoutMilli: 50_000n, feeMilli: 0n });
    expect(notice.body).toContain("11.875 feathers per contract. Fee: 0 feathers.");
  });
});
