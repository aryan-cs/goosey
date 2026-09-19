import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ market: vi.fn(), user: vi.fn(), marks: vi.fn() }));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  return {
    ApiError,
    apiErrorResponse: (error: { status?: number; code?: string }) => Response.json({ error: { code: error.code } }, { status: error.status ?? 500, headers: { "Cache-Control": "private, no-store" } }),
    prisma: { $transaction: (callback: (tx: unknown) => unknown) => callback({ market: { findUnique: mocks.market } }) },
  };
});
vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: mocks.user }));
vi.mock("@/lib/market-marks", () => ({ loadMarketMarks: mocks.marks }));

import { GET } from "./route";

const context = { params: Promise.resolve({ slug: "private-draft" }) };
const request = () => new NextRequest("http://localhost:8080/api/markets/private-draft");

describe("market detail draft authorization and cache isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.market.mockResolvedValue({ id: "draft-market", slug: "private-draft", status: "DRAFT", title: "Private draft title", pricingModel: "ORDER_BOOK", payoutMilli: 100_000n, priceHistory: [], orderFills: [], collateralAccountId: "internal-account", createdById: "admin" });
    mocks.marks.mockResolvedValue(new Map([["draft-market", { probabilityYesBps: null, source: "NO_LIQUIDITY", stale: false }]]));
  });

  it("never permits shared or private cache storage of an administrator's draft response", async () => {
    mocks.user.mockResolvedValue({ id: "admin", role: "ADMIN", status: "ACTIVE" });
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.title).toBe("Private draft title");
    expect(body).not.toHaveProperty("collateralAccountId");
    expect(body).not.toHaveProperty("createdById");
  });

  it.each([null, { id: "participant", role: "USER", status: "ACTIVE" }])("denies draft retrieval to non-admin viewers without loading pricing (%j)", async (viewer) => {
    mocks.user.mockResolvedValue(viewer);
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "MARKET_NOT_FOUND" } });
    expect(mocks.marks).not.toHaveBeenCalled();
  });
});
