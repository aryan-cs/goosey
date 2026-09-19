vi.mock("@/lib/notification-preferences", () => ({ getNotificationFilter: vi.fn().mockResolvedValue({}) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  principal: { id: "user-a" },
  requireUser: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/market-service", () => ({
  requireUser: mocks.requireUser,
  prisma: {
    notification: {
      findMany: mocks.findMany,
      count: mocks.count,
      updateMany: mocks.updateMany,
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

import { GET, PATCH } from "./route";

function request(method: "GET" | "PATCH", query = ""): NextRequest {
  return new NextRequest(`http://localhost:8080/api/notifications${query}`, { method });
}

describe("/api/notifications ownership scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal = { id: "user-a" };
    mocks.requireUser.mockImplementation(async () => mocks.principal);
    mocks.findMany.mockResolvedValue([{ id: "notification-a", userId: "user-a" }]);
    mocks.count.mockResolvedValue(1);
    mocks.updateMany.mockResolvedValue({ count: 2 });
  });

  it("lists and counts notifications only for the authenticated user", async () => {
    const incoming = request("GET", "?limit=7");
    const response = await GET(incoming);

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user-a" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 7,
    });
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null } });
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
    await expect(response.json()).resolves.toEqual({ markedRead: 2 });
  });
});

it("applies the same preferences to the inbox, unread count, and mark-all action", async () => {
  const { getNotificationFilter } = await import("@/lib/notification-preferences");
  const filter = { type: { notIn: ["TRADE_CONFIRMED", "COMPLETE_SET_REDEEMED"] } };
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user-a" });
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.updateMany.mockResolvedValue({ count: 0 });
  vi.mocked(getNotificationFilter).mockResolvedValue(filter);
  try {
    expect((await GET(request("GET"))).status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "user-a", ...filter }) }));
    expect(mocks.count).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null, ...filter } });
    expect((await PATCH(request("PATCH"))).status).toBe(200);
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { userId: "user-a", readAt: null, ...filter }, data: { readAt: expect.any(Date) } });
  } finally { vi.mocked(getNotificationFilter).mockResolvedValue({}); }
});
