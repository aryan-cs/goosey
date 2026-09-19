import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn(), startup: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {}, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  return { ApiError, prisma: {}, consumeRateLimit: mocks.rate, jsonResponse: NextResponse.json,
    apiErrorResponse: (error: unknown) => NextResponse.json({ error: {
      code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
    { status: error instanceof ApiError ? error.status : 500 }) };
});
vi.mock("@/lib/security", () => ({ requestRateLimitKey: () => "entry-rate" }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/catalog-entry", async original => ({
  ...await original<typeof import("@/lib/solana/catalog-entry")>(), readSolanaCatalogEntry: mocks.read,
}));
import { GET } from "./route";
import { ApiError } from "@/lib/market-service";
const deployment = { cluster: "localnet", genesisHash: "server-genesis", programAddress: "server-program" };
const item = { id: "social-id", slug: "published-market", chain: { marketId: "7" } };
const get = (id = "7", query = "") => GET(new NextRequest(`http://localhost:8080/api/solana/markets/${id}/catalog${query}`),
  { params: Promise.resolve({ marketId: id }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.resolve.mockReturnValue(deployment); mocks.read.mockResolvedValue(item);
});
afterEach(() => vi.unstubAllEnvs());

describe("catalog entry route: mocked service boundary", () => {
  it("uses server deployment, startup guard and rate limit, returning the social entry uncached", async () => {
    const response = await get();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ item });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).toHaveBeenCalledWith(process.env);
    expect(mocks.read).toHaveBeenCalledWith(deployment, "7");
    expect(mocks.rate).toHaveBeenCalledWith({}, "entry-rate", 60, 60_000);
    expect(mocks.startup.mock.invocationCallOrder[0]).toBeLessThan(mocks.rate.mock.invocationCallOrder[0]);
  });
  it.each([undefined, "false", "TRUE", "1"])("requires the exact feature gate %s", async value => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", value);
    const response = await get(); expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["?cluster=devnet", "?genesisHash=x", "?programAddress=x", "?rpcUrl=x", "?wallet=x",
    "?limit=1", "?x=1&x=2", "?cursor="])("rejects any query override %s", async query => {
      expect((await get("7", query)).status).toBe(400);
      expect(mocks.startup).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
    });
  it.each(["01", "-1", "18446744073709551616"])("rejects noncanonical ID %s", async id => {
    expect((await get(id)).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("returns an indistinguishable 404 for any absent/unpublished/wrong-deployment entry", async () => {
    mocks.read.mockResolvedValue(null);
    const response = await get(); expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "CATALOG_ENTRY_NOT_FOUND" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("sanitizes invalid server configuration", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("secret config"); });
    const response = await get(); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret"); expect(mocks.startup).not.toHaveBeenCalled();
  });
  it("does not query or rate-write after startup refusal", async () => {
    mocks.startup.mockRejectedValue(new Error("secret database"));
    const response = await get(); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret"); expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns rate limit failure without reading", async () => {
    mocks.rate.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Wait"));
    const response = await get(); expect(response.status).toBe(429);
    expect(mocks.read).not.toHaveBeenCalled(); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("sanitizes storage failures", async () => {
    mocks.read.mockRejectedValue(new Error("secret database"));
    const response = await get(); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
