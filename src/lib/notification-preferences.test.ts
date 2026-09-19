import { beforeEach, describe, expect, it, vi } from "vitest";
const findUniqueOrThrow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { user: { findUniqueOrThrow } } }));
import { defaultNotificationPreferences, getNotificationFilter, notificationTypeFilter, parseNotificationPreferences } from "./notification-preferences";

describe("notification visibility preferences", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each([undefined, null, "{}", "null", "[]", "invalid", '{"trades":"false"}'])("defaults invalid or absent preferences to visible: %s", (value) => {
    expect(parseNotificationPreferences(value)).toEqual(defaultNotificationPreferences);
  });
  it("preserves valid settings while defaulting absent categories", () => {
    expect(parseNotificationPreferences('{"trades":false,"unknown":false}')).toEqual({ ...defaultNotificationPreferences, trades: false });
  });
  it("only hides explicitly recognized optional types", () => {
    expect(notificationTypeFilter({ trades: false, resolutions: false, replies: false, suggestions: false })).toEqual({
      type: { notIn: ["TRADE_CONFIRMED", "COMPLETE_SET_REDEEMED", "MARKET_RESOLVED", "COMMENT_REPLY", "SUGGESTION_REVIEWED"] },
    });
    expect(notificationTypeFilter(defaultNotificationPreferences)).toEqual({});
  });
  it("loads only the requested user's preferences and excludes the disabled category", async () => {
    findUniqueOrThrow.mockResolvedValue({ notificationPreferences: '{"replies":false}' });
    expect(await getNotificationFilter("user-a")).toEqual({ type: { notIn: ["COMMENT_REPLY"] } });
    expect(findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "user-a" }, select: { notificationPreferences: true } });
  });
  it("can load preferences from the caller's transaction snapshot", async () => {
    const transactionRead = vi.fn().mockResolvedValue({ notificationPreferences: '{"trades":false}' });

    await expect(getNotificationFilter("user-a", { user: { findUniqueOrThrow: transactionRead } } as never))
      .resolves.toEqual({ type: { notIn: ["TRADE_CONFIRMED", "COMPLETE_SET_REDEEMED"] } });

    expect(transactionRead).toHaveBeenCalledWith({ where: { id: "user-a" }, select: { notificationPreferences: true } });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });
});
