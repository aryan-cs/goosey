import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, requireDatabaseStartup: vi.fn() }));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  }
  const response = (value: unknown, init?: ResponseInit) => NextResponse.json(value, init);
  return {
    ApiError,
    prisma: {},
    consumeRateLimit: mocks.rate,
    jsonResponse: (value: unknown, init?: ResponseInit) => response(value, init),
    apiErrorResponse: (error: unknown) => response(
      { error: { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
      { status: error instanceof ApiError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } },
    ),
  };
});
vi.mock("@/lib/security", () => ({ requestRateLimitKey: () => "indexer-status-rate-key" }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/indexer-health", () => ({ readPublicSolanaIndexerStatus: mocks.read }));

import { GET } from "./route";

const deployment = {
  cluster: "localnet",
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q",
  rpcUrl: "https://private.invalid/?token=provider-secret",
};
const status = {
  worker: { state: "running", updatedAt: "2026-09-19T12:00:00.000Z", cycleCount: "9",
    successCount: "8", failureCount: "1", consecutiveFailures: 0 },
  coverage: { status: "bounded_complete", revision: 12, updatedAt: "2026-09-19T11:59:00.000Z", fullHistory: false },
};
const request = (query = "") => new NextRequest(`http://localhost:8080/api/solana/indexer/status${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.resolve.mockReturnValue(deployment);
  mocks.read.mockResolvedValue(status);
});
afterEach(() => vi.unstubAllEnvs());

describe("public Solana indexer operational status", () => {
  it("returns the bounded projection uncached and rate limited", async () => {
    const response = await GET(request());
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual(status);
    expect(mocks.resolve).toHaveBeenCalledWith(process.env);
    expect(mocks.rate).toHaveBeenCalledWith({}, "indexer-status-rate-key", 60, 60_000);
    expect(mocks.read).toHaveBeenCalledWith(deployment);
    for (const hidden of ["provider-secret", "private.invalid", "rpcUrl", "signature", "lastError"]) {
      expect(text).not.toContain(hidden);
    }
    expect(JSON.parse(text).coverage.fullHistory).toBe(false);
  });

  it.each([undefined, "false", "TRUE", "1"])('requires the exact catalog gate "true" (%s)', async value => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", value);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CHAIN_INDEXER_UNAVAILABLE");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("fails closed when the exact server runtime cannot be resolved", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("private RPC token=do-not-return"); });
    const response = await GET(request());
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(JSON.parse(text).error.code).toBe("CHAIN_INDEXER_UNAVAILABLE");
    expect(text).not.toContain("do-not-return");
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["?rpc=https://evil.invalid", "?status=running", "?x=1&x=2"])(
    "rejects unsupported query input before rate-limit or database work: %s", async query => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_QUERY");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.rate).not.toHaveBeenCalled();
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it("returns the bounded rate-limit response without reading status", async () => {
    const { ApiError } = await import("@/lib/market-service");
    mocks.rate.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Too many requests", { retryAfter: 10 }));
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("sanitizes database and health failures", async () => {
    mocks.read.mockRejectedValue(new Error("worker row leaked secret and private RPC"));
    const response = await GET(request());
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("leaked secret");
    expect(text).not.toContain("private RPC");
  });

  it.each(["missing", "stale", "failing", "running"])("preserves the distinct public worker state %s", async state => {
    mocks.read.mockResolvedValue({ ...status, worker: { ...status.worker, state } });
    const response = await GET(request());
    expect((await response.json()).worker.state).toBe(state);
  });
});
