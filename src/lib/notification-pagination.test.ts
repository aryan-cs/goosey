import { describe, expect, it } from "vitest";

import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  NotificationCursorError,
} from "./notification-pagination";

const CURSOR_ID = "cm12345678901234567890123";

describe("notification pagination cursors", () => {
  it("round-trips the timestamp and tie-breaker ID", () => {
    const createdAt = new Date("2026-09-19T14:00:00.123Z");
    const encoded = encodeNotificationCursor({ createdAt, id: CURSOR_ID });

    expect(decodeNotificationCursor(encoded)).toEqual({ createdAt, id: CURSOR_ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ["invalid alphabet", "%%%"],
    ["invalid JSON", Buffer.from("not-json").toString("base64url")],
    ["extra payload field", Buffer.from(JSON.stringify({ createdAt: "2026-09-19T14:00:00.000Z", id: CURSOR_ID, userId: "other" })).toString("base64url")],
    ["invalid timestamp", Buffer.from(JSON.stringify({ createdAt: "yesterday", id: CURSOR_ID })).toString("base64url")],
    ["invalid ID", Buffer.from(JSON.stringify({ createdAt: "2026-09-19T14:00:00.000Z", id: "notification" })).toString("base64url")],
    ["oversized", "a".repeat(513)],
  ])("rejects %s", (_label, cursor) => {
    expect(() => decodeNotificationCursor(cursor)).toThrow(NotificationCursorError);
  });
});
