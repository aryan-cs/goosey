import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), load: vi.fn(), tx: {} }));
vi.mock("@/lib/market-service", async () => {
  const { jsonStringify } = await import("@/lib/serializers");
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  return {
    ApiError, prisma: {}, requireUser: mocks.requireUser,
    jsonResponse: (body: unknown, init?: ResponseInit) => new Response(jsonStringify(body), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    }),
    apiErrorResponse: (error: { status?: number; code?: string }) => Response.json({ code: error.code }, { status: error.status ?? 500 }),
  };
});
vi.mock("@/lib/serializable-transaction", () => ({ runSerializableTransaction: (_db: unknown, operation: (tx: unknown) => unknown) => operation(mocks.tx) }));
vi.mock("@/lib/trade-history", async (original) => ({ ...await original<typeof import("@/lib/trade-history")>(), loadTradeHistory: mocks.load }));
import { encodeTradeHistoryCursor } from "@/lib/trade-history";
import { GET } from "./route";

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toContain("Cookie");
}

describe("private unified portfolio history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "signed-in-user" });
    mocks.load.mockResolvedValue({ items: [], nextCursor: null });
  });
  it("loads only the authenticated user's history and disables shared caching", async () => {
    const response = await GET(new NextRequest("http://localhost/api/portfolio/history?limit=5"));
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith(mocks.tx, "signed-in-user", { limit: 5, cursor: undefined });
    expectPrivateNoStore(response);
  });
  it("defaults to thirty rows when no limit or cursor is supplied", async () => {
    const response = await GET(new NextRequest("http://localhost/api/portfolio/history"));

    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith(mocks.tx, "signed-in-user", { limit: 30, cursor: undefined });
    expectPrivateNoStore(response);
  });
  it("decodes and forwards a valid opaque cursor", async () => {
    const createdAt = new Date("2026-09-19T12:00:00.000Z");
    const cursor = encodeTradeHistoryCursor({ createdAt, id: "orderbook:fill_cursor_1" });

    const response = await GET(new NextRequest(`http://localhost/api/portfolio/history?limit=7&cursor=${encodeURIComponent(cursor)}`));

    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith(mocks.tx, "signed-in-user", {
      limit: 7,
      cursor: { createdAt, id: "orderbook:fill_cursor_1" },
    });
  });
  it("serializes monetary bigints and dates with the production JSON contract", async () => {
    const createdAt = new Date("2026-09-19T12:34:56.789Z");
    mocks.load.mockResolvedValue({
      items: [{
        id: "orderbook:fill_1",
        market: { slug: "private-book", shortTitle: "Private book" },
        side: "NO",
        action: "BUY",
        quantity: 3,
        amountMilli: 180_000n,
        feeMilli: 1_800n,
        createdAt,
        source: "ORDER_BOOK",
      }],
      nextCursor: "next-opaque-cursor",
    });

    const response = await GET(new NextRequest("http://localhost/api/portfolio/history?limit=1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [{
        id: "orderbook:fill_1",
        market: { slug: "private-book", shortTitle: "Private book" },
        side: "NO",
        action: "BUY",
        quantity: 3,
        amountMilli: "180000",
        feeMilli: "1800",
        createdAt: createdAt.toISOString(),
        source: "ORDER_BOOK",
      }],
      nextCursor: "next-opaque-cursor",
    });
    expectPrivateNoStore(response);
  });
  it.each(["userId=another-user", "limit=0", "limit=101", "limit=2&limit=3", "cursor=broken", "cursor="])("rejects invalid query %s before reading history", async (query) => {
    const response = await GET(new NextRequest(`http://localhost/api/portfolio/history?${query}`));
    expect(response.status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  it("does not query trades when signed out", async () => {
    mocks.requireUser.mockRejectedValue({ status: 401, code: "UNAUTHORIZED" });
    const response = await GET(new NextRequest("http://localhost/api/portfolio/history"));
    expect(response.status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("returns a private no-store error when history loading fails", async () => {
    mocks.load.mockRejectedValue(new Error("history read failed"));

    const response = await GET(new NextRequest("http://localhost/api/portfolio/history"));

    expect(response.status).toBe(500);
    expect(mocks.load).toHaveBeenCalledOnce();
    expectPrivateNoStore(response);
  });
});
