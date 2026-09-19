import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $transaction: vi.fn() }, requireDatabaseStartup: vi.fn() }));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
  }
  const response = (value: unknown, init?: ResponseInit) => NextResponse.json(
    JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)), init);
  return { ApiError, prisma: {}, consumeRateLimit: mocks.rate,
    jsonResponse: (value: unknown, init?: ResponseInit) => response(value, init),
    apiErrorResponse: (error: unknown) => response({ error: { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
      { status: error instanceof ApiError ? error.status : 500, headers: { "Cache-Control": "private, no-store" } }),
  };
});
vi.mock("@/lib/security", () => ({ requestRateLimitKey: () => "trade-tape-rate-key" }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/trade-tape", async original => ({
  ...await original<typeof import("@/lib/solana/trade-tape")>(), readSolanaTradeTape: mocks.read,
}));

import { GET } from "./route";

const programAddress = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const deployment = { cluster: "localnet", genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress, rpcUrl: "http://private-rpc.invalid/key" };
const request = (query = "") => new NextRequest(`http://localhost:8080/api/solana/markets/7/trades${query}`);
const run = (query = "", marketId = "7") => GET(request(query), { params: Promise.resolve({ marketId }) });

beforeEach(() => {
  vi.resetAllMocks(); mocks.resolve.mockReturnValue(deployment);
  mocks.read.mockResolvedValue({ items: [{ signature: "transaction", slot: 30n, logIndex: 8,
    quantity: 5n, yesPrice: 600n, makerFee: 7n, takerFee: 8n }], nextCursor: null,
  ordering: { direction: "desc", keys: ["slot", "signature", "logIndex"], semantics: "deterministic_journal_display_only" },
  coverage: { status: "partial", coverageStartSignature: "start", headSignature: "head",
    backfillComplete: false, revision: 1, updatedAt: new Date("2026-09-19T12:00:00.000Z"), fullHistory: false } });
});
afterEach(() => vi.unstubAllEnvs());

describe("mocked boundary: finalized Solana trade tape route", () => {
  it("serializes exact integer strings, coverage, no timestamp, rate limit, and no-store", async () => {
    const response = await run("?limit=10");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ items: [{ slot: "30", quantity: "5", yesPrice: "600", makerFee: "7", takerFee: "8" }],
      coverage: { status: "partial", backfillComplete: false, fullHistory: false } });
    expect(body.items[0]).not.toHaveProperty("timestamp"); expect(body.items[0]).not.toHaveProperty("createdAt");
    expect(mocks.rate).toHaveBeenCalledWith({}, "trade-tape-rate-key", 60, 60_000);
    expect(mocks.read).toHaveBeenCalledWith(deployment, 7n, { limit: 10 });
    expect(JSON.stringify(body)).not.toContain("private-rpc");
  });

  it.each(["-1", "01", "1e3", "18446744073709551616", "x".repeat(100)])("rejects invalid market ID %s before runtime/rate/read", async marketId => {
    const response = await run("", marketId); expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["?limit=1&limit=2", "?cursor=a&cursor=b", "?rpc=http://evil.invalid", "?limit=51", "?limit=01"])(
    "rejects repeated, unknown, and invalid query %s before rate/read", async query => {
      const response = await run(query); expect(response.status).toBe(400);
      expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    });

  it("fails closed when the server runtime is unavailable", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("private RPC missing"); });
    const response = await run(); const text = await response.text();
    expect(response.status).toBe(503); expect(JSON.parse(text).error.code).toBe("SOLANA_DISABLED");
    expect(text).not.toContain("private"); expect(mocks.rate).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns a no-store rate-limit response without reading the journal", async () => {
    const { ApiError } = await import("@/lib/market-service");
    mocks.rate.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Too many requests"));
    const response = await run(); expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store"); expect(mocks.read).not.toHaveBeenCalled();
  });

  it("sanitizes journal failures without inventing an empty successful tape", async () => {
    mocks.read.mockRejectedValue(new Error("journal secret"));
    const response = await run(); const text = await response.text();
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain("secret");
  });
});
