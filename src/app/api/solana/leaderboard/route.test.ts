import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, requireDatabaseStartup: vi.fn() }));
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
vi.mock("@/lib/security", () => ({ requestRateLimitKey: () => "chain-leaderboard-rate-key" }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/leaderboard", async (original) => ({
  ...await original<typeof import("@/lib/solana/leaderboard")>(), readSolanaLeaderboard: mocks.read,
}));

import { GET } from "./route";

const deployment = { cluster: "localnet", genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q", rpcUrl: "http://private.invalid/token" };
const body = { metric: "taker_filled_contracts", rows: [{ rank: 1,
  walletAddress: "8JkL3BGoGCgSAXZyJZbKDKCJvijocvLBaJcqF7iiM3fT", filledContracts: "8" }],
  coverage: { status: "partial", fullHistory: false } };
const request = (query = "") => new NextRequest(`http://localhost:8080/api/solana/leaderboard${query}`);

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.resolve.mockReturnValue(deployment); mocks.read.mockResolvedValue(body);
});
afterEach(() => vi.unstubAllEnvs());

describe("public finalized-chain leaderboard route", () => {
  it("returns the bounded projection uncached and rate limited", async () => {
    const response = await GET(request("?limit=25"));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(body);
    expect(mocks.resolve).toHaveBeenCalledWith(process.env);
    expect(mocks.rate).toHaveBeenCalledWith({}, "chain-leaderboard-rate-key", 60, 60_000);
    expect(mocks.read).toHaveBeenCalledWith(deployment, { limit: 25 });
  });

  it.each([undefined, "false", "TRUE", "1"])("requires the exact public-chain feature gate (%s)", async value => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", value);
    const response = await GET(request());
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("CHAIN_LEADERBOARD_UNAVAILABLE");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["?limit=1&limit=2", "?limit=0", "?limit=101", "?limit=01", "?rpc=http://evil.invalid"])(
    "rejects repeated, unknown, or invalid query %s before rate/database work", async query => {
      const response = await GET(request(query));
      expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("fails closed without leaking runtime configuration", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("private provider token"); });
    const response = await GET(request()); const text = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(text).error.code).toBe("CHAIN_LEADERBOARD_UNAVAILABLE");
    expect(text).not.toContain("provider token"); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("does not query the projection after rate limiting", async () => {
    const { ApiError } = await import("@/lib/market-service");
    mocks.rate.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Too many requests"));
    const response = await GET(request());
    expect(response.status).toBe(429); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("sanitizes read failures and keeps errors uncached", async () => {
    mocks.read.mockRejectedValue(new Error("database secret"));
    const response = await GET(request()); const text = await response.text();
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("secret");
  });
});
