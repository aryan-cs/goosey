export type NotificationFeedItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationFeedPage = {
  items: NotificationFeedItem[];
  nextCursor: string | null;
  unreadCount: number;
  visibilityKey: string;
};

export type NotificationFeed = NotificationFeedPage & {
  olderLoaded: boolean;
  headFingerprint: string;
  newUpdates: boolean;
  signedOut: boolean;
  initialized: boolean;
};

export type NotificationFeedMode = "poll" | "replace" | "more";

export type NotificationFeedMerge = {
  feed: NotificationFeed;
  reloadHead: boolean;
};

export const EMPTY_NOTIFICATION_FEED: NotificationFeed = {
  items: [],
  nextCursor: null,
  unreadCount: 0,
  visibilityKey: "",
  olderLoaded: false,
  headFingerprint: "",
  newUpdates: false,
  signedOut: false,
  initialized: false,
};

function isNotificationFeedItem(value: unknown): value is NotificationFeedItem {
  if (!value || typeof value !== "object") return false;
  const item = value as NotificationFeedItem;
  return typeof item.id === "string" &&
    typeof item.type === "string" &&
    typeof item.title === "string" &&
    typeof item.body === "string" &&
    typeof item.createdAt === "string" &&
    (item.readAt === null || typeof item.readAt === "string") &&
    (item.href === null || typeof item.href === "string");
}

export function isNotificationFeedPage(value: unknown): value is NotificationFeedPage {
  if (!value || typeof value !== "object") return false;
  const page = value as NotificationFeedPage;
  return Array.isArray(page.items) && page.items.every(isNotificationFeedItem) &&
    Number.isSafeInteger(page.unreadCount) && page.unreadCount >= 0 &&
    (page.nextCursor === null || typeof page.nextCursor === "string") &&
    typeof page.visibilityKey === "string";
}

function fingerprint(items: readonly NotificationFeedItem[]) {
  return JSON.stringify(items.map(({ id, readAt }) => [id, readAt]));
}

function replaceFeed(page: NotificationFeedPage): NotificationFeed {
  return {
    ...page,
    olderLoaded: false,
    headFingerprint: fingerprint(page.items),
    newUpdates: false,
    signedOut: false,
    initialized: true,
  };
}

export function mergeNotificationFeed(
  previous: NotificationFeed,
  page: NotificationFeedPage,
  mode: NotificationFeedMode,
): NotificationFeedMerge {
  const visibilityChanged = previous.initialized && previous.visibilityKey !== page.visibilityKey;

  if (mode === "more" && (!previous.initialized || visibilityChanged)) {
    return {
      feed: {
        ...EMPTY_NOTIFICATION_FEED,
        visibilityKey: page.visibilityKey,
        unreadCount: page.unreadCount,
        initialized: true,
      },
      reloadHead: true,
    };
  }

  if (mode === "replace" || !previous.initialized || visibilityChanged || (mode === "poll" && !previous.olderLoaded)) {
    return { feed: replaceFeed(page), reloadHead: false };
  }

  if (mode === "more") {
    const seen = new Set(previous.items.map((item) => item.id));
    return {
      feed: {
        ...previous,
        items: [...previous.items, ...page.items.filter((item) => !seen.has(item.id))],
        nextCursor: page.nextCursor,
        unreadCount: page.unreadCount,
        visibilityKey: page.visibilityKey,
        olderLoaded: true,
      },
      reloadHead: false,
    };
  }

  return {
    feed: {
      ...previous,
      unreadCount: page.unreadCount,
      visibilityKey: page.visibilityKey,
      newUpdates: fingerprint(page.items) !== previous.headFingerprint,
    },
    reloadHead: false,
  };
}
