vi.mock("@/lib/mutation-session", async () => {
  const { prisma } = await import("@/lib/market-service");
  return { runAuthenticatedMutation: async (_request: unknown, _userId: string, operation: (tx: unknown, actor: { role: string }) => Promise<unknown>) => {
    if ("$transaction" in prisma) return prisma.$transaction((tx) => operation(tx, { role: "USER" }));
    return operation(prisma, { role: "USER" });
  } };
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ZodError } from "zod";

const mocks = vi.hoisted(() => ({
  principal: { id: "cm12345678901234567890121", role: "USER", status: "ACTIVE" },
  commentUpdate: vi.fn(), commentFind: vi.fn(), marketUpdate: vi.fn(),
  watchlistFind: vi.fn(), watchlistDelete: vi.fn(), watchlistUpsert: vi.fn(), marketFind: vi.fn(),
  suggestionFind: vi.fn(), suggestionCreate: vi.fn(), notificationUpdate: vi.fn(),
}));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const tx = {
    comment: { updateMany: mocks.commentUpdate, findUnique: mocks.commentFind },
    market: { updateMany: mocks.marketUpdate, findFirst: mocks.marketFind },
    watchlistEntry: { findMany: mocks.watchlistFind, deleteMany: mocks.watchlistDelete, upsert: mocks.watchlistUpsert },
    marketSuggestion: { findMany: mocks.suggestionFind, create: mocks.suggestionCreate },
    notification: { updateMany: mocks.notificationUpdate },
  };
  return {
    ApiError,
    requireUser: vi.fn(async () => mocks.principal),
    consumeRateLimit: vi.fn(),
    jsonResponse: (value: unknown, init?: ResponseInit) => Response.json(value, init),
    apiErrorResponse: (error: unknown) => {
      const candidate = error as { status?: number; code?: string };
      return Response.json({ error: { code: candidate.code } }, { status: error instanceof ZodError ? 400 : candidate.status ?? 500 });
    },
    prisma: {
      $transaction: (callback: (tx: unknown) => unknown) => callback(tx),
      watchlistEntry: { findMany: mocks.watchlistFind, deleteMany: mocks.watchlistDelete, upsert: mocks.watchlistUpsert },
      market: { findFirst: mocks.marketFind },
      marketSuggestion: { findMany: mocks.suggestionFind, create: mocks.suggestionCreate },
      notification: { updateMany: mocks.notificationUpdate },
    },
  };
});

import { PATCH as editComment, DELETE as deleteComment } from "./comments/[id]/route";
import { GET as getWatchlist, POST as addWatchlist, DELETE as deleteWatchlist } from "./watchlist/route";
import { GET as getSuggestions, POST as addSuggestion } from "./suggestions/route";
import { PATCH as readNotification } from "./notifications/[id]/route";

const VICTIM = "cm12345678901234567890122";
const RESOURCE = "cm12345678901234567890123";
const context = { params: Promise.resolve({ id: RESOURCE }) };
function request(method: string, body?: unknown) {
  return new NextRequest(`http://localhost:8080/api/test?userId=${VICTIM}`, {
    method, headers: { origin: "http://localhost:8080", "content-type": "application/json", "x-user-id": VICTIM, "x-role": "ADMIN" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("hostile object authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.commentUpdate.mockResolvedValue({ count: 0 });
    mocks.commentFind.mockResolvedValue({ userId: VICTIM, marketId: RESOURCE, status: "VISIBLE" });
    mocks.watchlistFind.mockResolvedValue([]);
    mocks.watchlistDelete.mockResolvedValue({ count: 0 });
    mocks.marketFind.mockResolvedValue(null);
    mocks.suggestionFind.mockResolvedValue([]);
    mocks.notificationUpdate.mockResolvedValue({ count: 0 });
  });

  it("rejects editing or deleting somebody else's comment despite forged identity headers", async () => {
    expect((await editComment(request("PATCH", { body: "Attacker changed this" }), context)).status).toBe(403);
    expect(mocks.commentUpdate).toHaveBeenCalledWith({ where: { id: RESOURCE, userId: mocks.principal.id, status: "VISIBLE" }, data: { body: "Attacker changed this" } });
    mocks.commentUpdate.mockClear();
    expect((await deleteComment(request("DELETE"), context)).status).toBe(403);
    expect(mocks.commentUpdate).not.toHaveBeenCalled();
    expect(mocks.marketUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { userId: VICTIM }, { marketId: RESOURCE }, { status: "VISIBLE" },
    { parentId: RESOURCE }, { positionQtySnapshot: "1000000000" },
  ])("rejects comment mass assignment %j", async (extra) => {
    expect((await editComment(request("PATCH", { body: "Attacker changed this", ...extra }), context)).status).toBe(400);
    expect(mocks.commentUpdate).not.toHaveBeenCalled();
  });

  it("scopes watchlist reads and removals to the signed-in owner despite URL/header overrides", async () => {
    expect((await getWatchlist(request("GET"))).status).toBe(200);
    expect(mocks.watchlistFind).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: mocks.principal.id, market: { status: { not: "DRAFT" } } } }));
    expect((await deleteWatchlist(request("DELETE", { marketId: RESOURCE }))).status).toBe(200);
    expect(mocks.watchlistDelete).toHaveBeenCalledWith({ where: { userId: mocks.principal.id, marketId: RESOURCE } });
  });

  it("rejects assigning somebody else's watchlist entry and cannot save a draft", async () => {
    expect((await addWatchlist(request("POST", { marketId: RESOURCE, userId: VICTIM }))).status).toBe(400);
    expect((await addWatchlist(request("POST", { marketId: RESOURCE }))).status).toBe(404);
    expect(mocks.marketFind).toHaveBeenCalledWith({ where: { id: RESOURCE, status: { not: "DRAFT" } }, select: { id: true } });
    expect(mocks.watchlistUpsert).not.toHaveBeenCalled();
  });

  it("scopes suggestion reads to the owner and rejects forged reviewer/status fields", async () => {
    expect((await getSuggestions(request("GET"))).status).toBe(200);
    expect(mocks.suggestionFind).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: mocks.principal.id } }));
    const body = { title: "Will this market be approved?", description: "A participant must never approve their own submitted market proposal.", category: "Campus" };
    for (const extra of [{ userId: VICTIM }, { status: "APPROVED" }, { reviewedById: VICTIM }]) {
      expect((await addSuggestion(request("POST", { ...body, ...extra }))).status).toBe(400);
    }
    expect(mocks.suggestionCreate).not.toHaveBeenCalled();
  });

  it("cannot mark another account's notification as read", async () => {
    expect((await readNotification(request("PATCH", { userId: VICTIM }), context)).status).toBe(404);
    expect(mocks.notificationUpdate).toHaveBeenCalledWith({ where: { id: RESOURCE, userId: mocks.principal.id }, data: { readAt: expect.any(Date) } });
  });
});
