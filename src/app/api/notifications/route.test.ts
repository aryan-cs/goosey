vi.mock("@/lib/mutation-session", () => ({
  runAuthenticatedMutation: async (_request: unknown, _userId: string, operation: (tx: unknown) => Promise<unknown>) => operation(mocks.tx),
}));
vi.mock("@/lib/notification-preferences", () => ({ getNotificationFilter: vi.fn().mockResolvedValue({}) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => {
  const findMany = vi.fn();
  const count = vi.fn();
  const updateMany = vi.fn();
  const tx = { notification: { findMany, count, updateMany } };
  return {
    principal: { id: "user-a" },
    requireUser: vi.fn(),
    findMany,
    count,
    updateMany,
    tx,
    runSerializableTransaction: vi.fn((_client: unknown, operation: (transaction: unknown) => unknown) => operation(tx)),
  };
});

vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  requireUser: mocks.requireUser,
  prisma: {
    notification: {
      findMany: vi.fn(() => { throw new Error("Inbox reads must use the snapshot client"); }),
      count: vi.fn(() => { throw new Error("Unread counts must use the snapshot client"); }),
      updateMany: vi.fn(() => { throw new Error("Mark-read must use the mutation client"); }),
    },
  },
  jsonResponse: vi.fn((value: unknown, init?: ResponseInit) => Response.json(value, init)),
  apiErrorResponse: vi.fn((error: unknown) => {
    const candidate = error as { status?: number; code?: string; message?: string };
    return Response.json(
      { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message ?? "error" } },
      { status: candidate.status ?? 500 },
    );
  }),
}));

vi.mock("@/lib/serializable-transaction", () => ({
  runSerializableTransaction: mocks.runSerializableTransaction,
}));

import { GET, PATCH } from "./route";
import { decodeNotificationCursor, encodeNotificationCursor } from "@/lib/notification-pagination";
import { getNotificationFilter } from "@/lib/notification-preferences";

const CREATED_AT = new Date("2026-09-19T14:00:00.000Z");
const ID_3 = "cm12345678901234567890123";
const ID_2 = "cm12345678901234567890122";
const ID_1 = "cm12345678901234567890121";

function request(method: "GET" | "PATCH", query = ""): NextRequest {
  return new NextRequest(`http://localhost:8080/api/notifications${query}`, { method });
}

describe("/api/notifications ownership scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal = { id: "user-a" };
    mocks.requireUser.mockImplementation(async () => mocks.principal);
    mocks.findMany.mockResolvedValue([{ id: ID_3, userId: "user-a", createdAt: CREATED_AT }]);
    mocks.count.mockResolvedValue(1);
    mocks.updateMany.mockResolvedValue({ count: 2 });
  });

  it("lists and counts notifications only for the authenticated user", async () => {
    const incoming = request("GET", "?limit=7");
    const response = await GET(incoming);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user-a" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 8,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null } });
    await expect(response.json()).resolves.toMatchObject({ unreadCount: 1, nextCursor: null, visibilityKey: "{}" });
    expect(mocks.runSerializableTransaction).toHaveBeenCalledOnce();
    expect(getNotificationFilter).toHaveBeenCalledWith("user-a", mocks.tx);
  });

  it("uses a scoped lexicographic predicate for equal timestamps without loading the cursor row", async () => {
    const cursor = encodeNotificationCursor({ createdAt: CREATED_AT, id: ID_2 });
    mocks.findMany.mockResolvedValue([{ id: ID_1, userId: "user-a", createdAt: CREATED_AT }]);

    const response = await GET(request("GET", `?limit=2&cursor=${encodeURIComponent(cursor)}`));

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        userId: "user-a",
        OR: [
          { createdAt: { lt: CREATED_AT } },
          { createdAt: CREATED_AT, id: { lt: ID_2 } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
  });

  it("uses lookahead and returns a cursor for the final visible item", async () => {
    mocks.count.mockResolvedValue(9);
    mocks.findMany.mockResolvedValue([
      { id: ID_3, userId: "user-a", createdAt: CREATED_AT },
      { id: ID_2, userId: "user-a", createdAt: CREATED_AT },
      { id: ID_1, userId: "user-a", createdAt: CREATED_AT },
    ]);

    const response = await GET(request("GET", "?limit=2"));
    const body = await response.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual([ID_3, ID_2]);
    expect(body.unreadCount).toBe(9);
    expect(decodeNotificationCursor(body.nextCursor)).toEqual({ createdAt: CREATED_AT, id: ID_2 });
  });

  it.each([
    "?limit=2&limit=3",
    `?cursor=${encodeNotificationCursor({ createdAt: CREATED_AT, id: ID_3 })}&cursor=${encodeNotificationCursor({ createdAt: CREATED_AT, id: ID_2 })}`,
  ])("rejects repeated query parameters before opening a snapshot: %s", async (query) => {
    const response = await GET(request("GET", query));

    expect(response.status).toBe(400);
    expect(mocks.runSerializableTransaction).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor before querying notifications", async () => {
    const response = await GET(request("GET", "?cursor=not-a-valid-cursor"));

    expect(response.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("marks only the authenticated user's unread notifications", async () => {
    const incoming = request("PATCH");
    const response = await PATCH(incoming);

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming, true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-a", readAt: null },
      data: { readAt: expect.any(Date) },
    });
    expect(getNotificationFilter).toHaveBeenCalledWith("user-a", mocks.tx);
    await expect(response.json()).resolves.toEqual({ markedRead: 2 });
  });
});

it("applies the same preferences to the inbox, unread count, and mark-all action", async () => {
  const { getNotificationFilter } = await import("@/lib/notification-preferences");
  const filter = { type: { notIn: ["TRADE_CONFIRMED", "COMPLETE_SET_REDEEMED"] } };
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user-a" });
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(4);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  vi.mocked(getNotificationFilter).mockResolvedValue(filter);
  try {
    const listing = await GET(request("GET"));
    expect(listing.status).toBe(200);
    const body = await listing.json();
    expect(body.visibilityKey).toBe(JSON.stringify(filter));
    expect(body.unreadCount).toBe(4);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user-a", ...filter }) }));
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null, ...filter } });
    expect((await PATCH(request("PATCH"))).status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null, ...filter }, data: { readAt: expect.any(Date) } });
  } finally { vi.mocked(getNotificationFilter).mockResolvedValue({}); }
});
