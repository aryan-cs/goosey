import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { findUniqueOrThrow: mocks.findUniqueOrThrow } } }));
vi.mock("@/lib/market-service", () => ({
  requireUser: mocks.requireUser,
  prisma: { user: { findUniqueOrThrow: mocks.findUniqueOrThrow, update: mocks.update } },
  jsonResponse: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  apiErrorResponse: (error: { status?: number; name?: string }) => Response.json({ error: true }, { status: error.status ?? (error.name === "ZodError" ? 400 : 500) }),
}));
import { GET, PATCH } from "./route";
const preferences = { trades: false, resolutions: true, replies: false, suggestions: true };
function request(body?: unknown) {
  return new NextRequest("http://localhost:8080/api/settings/notifications", body === undefined ? {} : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("notification preferences API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "owner" });
    mocks.findUniqueOrThrow.mockResolvedValue({ notificationPreferences: "{}" });
    mocks.update.mockResolvedValue({ id: "owner" });
  });
  it("returns private, default-on preferences for the authenticated account", async () => {
    const incoming = request(); const response = await GET(incoming);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ preferences: { trades: true, resolutions: true, replies: true, suggestions: true } });
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming);
    expect(mocks.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "owner" }, select: { notificationPreferences: true } });
  });
  it("requires mutation checks and saves only the authenticated account", async () => {
    const incoming = request(preferences); const response = await PATCH(incoming);
    expect(response.status).toBe(200); expect(mocks.requireUser).toHaveBeenCalledWith(incoming, true);
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: "owner" }, data: { notificationPreferences: JSON.stringify(preferences) }, select: { id: true } });
    expect(await response.json()).toEqual({ preferences });
  });
  it.each([{ ...preferences, userId: "other" }, { ...preferences, trades: "false" }, { trades: false }])("rejects malformed or ownership-injecting payloads", async (payload) => {
    expect((await PATCH(request(payload))).status).toBe(400); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not read or write settings when authentication fails", async () => {
    mocks.requireUser.mockRejectedValue({ status: 401 });
    expect((await GET(request())).status).toBe(401); expect((await PATCH(request(preferences))).status).toBe(401);
    expect(mocks.findUniqueOrThrow).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("reports failed saves without claiming success", async () => {
    mocks.update.mockRejectedValue(new Error("offline")); expect((await PATCH(request(preferences))).status).toBe(500);
  });
});
