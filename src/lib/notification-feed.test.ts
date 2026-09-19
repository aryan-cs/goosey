import { describe, expect, it } from "vitest";

import {
  EMPTY_NOTIFICATION_FEED,
  isNotificationFeedPage,
  mergeNotificationFeed,
  type NotificationFeed,
  type NotificationFeedItem,
  type NotificationFeedPage,
} from "./notification-feed";

function item(id: string, readAt: string | null = null): NotificationFeedItem {
  return {
    id,
    type: "TRADE_CONFIRMED",
    title: `Notification ${id}`,
    body: "A notification body.",
    href: `/markets/${id}`,
    readAt,
    createdAt: "2026-09-19T12:00:00.000Z",
  };
}

function page(overrides: Partial<NotificationFeedPage> = {}): NotificationFeedPage {
  return {
    items: [item("new")],
    nextCursor: "next-page",
    unreadCount: 1,
    visibilityKey: "trades:on",
    ...overrides,
  };
}

function feed(overrides: Partial<NotificationFeed> = {}): NotificationFeed {
  const initial = mergeNotificationFeed(EMPTY_NOTIFICATION_FEED, page(), "replace").feed;
  return { ...initial, ...overrides };
}

describe("notification feed payload validation", () => {
  it("accepts the notification API page contract", () => {
    expect(isNotificationFeedPage(page())).toBe(true);
  });

  it.each([
    { ...page(), items: [{ ...item("bad"), readAt: 1 }] },
    { ...page(), unreadCount: -1 },
    { ...page(), unreadCount: 1.5 },
    { ...page(), nextCursor: 42 },
    { ...page(), visibilityKey: null },
  ])("rejects malformed pages", (value) => {
    expect(isNotificationFeedPage(value)).toBe(false);
  });
});

describe("mergeNotificationFeed", () => {
  it("replaces the feed and resets stale pagination and update state", () => {
    const replacement = page({ items: [item("replacement")], nextCursor: null, unreadCount: 0 });
    const result = mergeNotificationFeed(feed({ olderLoaded: true, newUpdates: true }), replacement, "replace");

    expect(result.reloadHead).toBe(false);
    expect(result.feed).toMatchObject({
      items: replacement.items,
      nextCursor: null,
      unreadCount: 0,
      olderLoaded: false,
      newUpdates: false,
      signedOut: false,
      initialized: true,
    });
  });

  it("replaces an unloaded head during polling", () => {
    const changed = page({ items: [item("new", "2026-09-19T13:00:00.000Z")] });
    const result = mergeNotificationFeed(feed(), changed, "poll");

    expect(result.feed.items).toEqual(changed.items);
    expect(result.feed.newUpdates).toBe(false);
  });

  it("preserves loaded older rows and flags head or read-status changes during polling", () => {
    const previous = feed({
      items: [item("new"), item("older")],
      olderLoaded: true,
      nextCursor: "older-cursor",
    });
    const result = mergeNotificationFeed(
      previous,
      page({ items: [item("new", "2026-09-19T13:00:00.000Z")], unreadCount: 0 }),
      "poll",
    );

    expect(result.feed.items).toEqual(previous.items);
    expect(result.feed.nextCursor).toBe("older-cursor");
    expect(result.feed.unreadCount).toBe(0);
    expect(result.feed.newUpdates).toBe(true);
  });

  it("appends older pages without duplicating overlapping rows", () => {
    const previous = feed({ items: [item("new")], nextCursor: "page-two" });
    const result = mergeNotificationFeed(
      previous,
      page({ items: [item("new"), item("older")], nextCursor: null, unreadCount: 2 }),
      "more",
    );

    expect(result.reloadHead).toBe(false);
    expect(result.feed.items.map(({ id }) => id)).toEqual(["new", "older"]);
    expect(result.feed).toMatchObject({ nextCursor: null, unreadCount: 2, olderLoaded: true });
  });

  it("requires a fresh head instead of appending a page fetched under changed preferences", () => {
    const result = mergeNotificationFeed(
      feed({ items: [item("now-hidden")], olderLoaded: true }),
      page({ items: [item("older-visible")], visibilityKey: "trades:off", unreadCount: 0 }),
      "more",
    );

    expect(result.reloadHead).toBe(true);
    expect(result.feed).toMatchObject({
      items: [],
      visibilityKey: "trades:off",
      unreadCount: 0,
      initialized: true,
    });
  });

  it("immediately replaces visible rows when preferences change during polling", () => {
    const changed = page({ items: [item("still-visible")], visibilityKey: "trades:off" });
    const result = mergeNotificationFeed(feed({ items: [item("now-hidden")], olderLoaded: true }), changed, "poll");

    expect(result.reloadHead).toBe(false);
    expect(result.feed.items).toEqual(changed.items);
    expect(result.feed.visibilityKey).toBe("trades:off");
    expect(result.feed.olderLoaded).toBe(false);
  });
});
