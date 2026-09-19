import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relative-time";

const now = new Date("2026-09-19T20:00:00.000Z");

describe("formatRelativeTime", () => {
  it.each([
    ["2026-09-19T19:59:55.000Z", "Just now"],
    ["2026-09-19T19:59:30.000Z", "30 seconds ago"],
    ["2026-09-19T19:55:00.000Z", "5 minutes ago"],
    ["2026-09-19T18:00:00.000Z", "2 hours ago"],
    ["2026-09-18T20:00:00.000Z", "1 day ago"],
    ["2026-09-19T20:05:00.000Z", "in 5 minutes"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });

  it("rejects invalid dates", () => {
    expect(() => formatRelativeTime("not-a-date", now)).toThrow(RangeError);
  });
});
