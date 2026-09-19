import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { market: { findMany: vi.fn() } }, requireDatabaseStartup: vi.fn() }));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  }
  const response = (value: unknown, init?: ResponseInit) => NextResponse.json(value, init);
  return { ApiError, prisma: {}, consumeRateLimit: mocks.rate,
    jsonResponse: (value: unknown, init?: ResponseInit) => response(value, init),
    apiErrorResponse: (error: unknown) => response({ error: { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
      { status: error instanceof ApiError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } }),
  };
});
vi.mock("@/lib/security", () => ({ requestRateLimitKey: () => "catalog-rate-key" }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/catalog-read", async (original) => ({
  ...await original<typeof import("@/lib/solana/catalog-read")>(), readSolanaCatalog: mocks.read,
}));

import { GET } from "./route";

const programAddress = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const deployment = { cluster: "localnet", genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress, rpcUrl: "http://private-rpc.invalid/key" };
const request = (query = "") => new NextRequest(`http://localhost:8080/api/solana/catalog${query}`);

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.resolve.mockReturnValue(deployment);
  mocks.read.mockResolvedValue({ items: [{ slug: "chain-market", href: "/chain/markets/7",
    chain: { marketId: "7", programAddress } }], nextCursor: null, hasMore: false });
});
afterEach(() => vi.unstubAllEnvs());

describe("mocked boundary: public Solana catalog route", () => {
  it("returns only the helper projection with no-store and request throttling", async () => {
    const response = await GET(request("?limit=10"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [{ slug: "chain-market", href: "/chain/markets/7",
      chain: { marketId: "7", programAddress } }], nextCursor: null, hasMore: false });
    expect(mocks.resolve).toHaveBeenCalledWith(process.env);
    expect(mocks.rate).toHaveBeenCalledWith({}, "catalog-rate-key", 60, 60_000);
    expect(mocks.read).toHaveBeenCalledWith(deployment, { limit: 10 });
  });

  it.each([undefined, "false", "TRUE", "1"])("is unavailable unless the exact feature gate is true (%s)", async (value) => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", value);
    const response = await GET(request());
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("CHAIN_CATALOG_UNAVAILABLE");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("fails closed when the complete server runtime is unavailable", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("missing private config"); });
    const response = await GET(request());
    const text = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(text).error.code).toBe("CHAIN_CATALOG_UNAVAILABLE");
    expect(text).not.toContain("private"); expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["?limit=1&limit=2", "?cursor=a&cursor=b", "?rpc=http://evil.invalid", "?limit=51", "?limit=01"])(
    "rejects repeated, unknown, or invalid query %s before rate/database work", async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    });

  it("returns a bounded rate-limit response without reading the catalog", async () => {
    const { ApiError } = await import("@/lib/market-service");
    mocks.rate.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Too many requests", { retryAfter: 8 }));
    const response = await GET(request());
    expect(response.status).toBe(429); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("sanitizes database/helper failures and keeps errors no-store", async () => {
    mocks.read.mockRejectedValue(new Error("database secret"));
    const response = await GET(request());
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("secret");
  });
});
