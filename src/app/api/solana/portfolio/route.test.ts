import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), configuration: vi.fn(), read: vi.fn(), rate: vi.fn() }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("@/lib/db", () => ({ db: {}, requireDatabaseStartup: vi.fn() }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE_NAME: "session" }));
vi.mock("@/lib/security", async original => ({ ...await original<typeof import("@/lib/security")>(), enforceRateLimit: mocks.rate,
  requestRateLimitKey: () => "portfolio-ip", identityRateLimitKey: (scope: string, id: string) => `${scope}:${id}` }));
vi.mock("../wallet/_shared", async original => ({ ...await original<typeof import("../wallet/_shared")>(),
  walletAuthentication: mocks.auth, walletConfiguration: mocks.configuration }));
vi.mock("@/lib/solana/portfolio", async original => ({ ...await original<typeof import("@/lib/solana/portfolio")>(), readSolanaPortfolio: mocks.read }));
import { ApiError } from "@/lib/market-service";
import { RateLimitError } from "@/lib/security";
import { GET } from "./route";
const runtime = { cluster: "localnet", genesisHash: "pinned-genesis", programAddress: "pinned-program", rpcUrl: "http://private-server" };
const request = (query = "") => new NextRequest(`http://localhost/api/solana/portfolio${query}`);
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.auth.mockResolvedValue({ userId: "current_user" }); mocks.configuration.mockReturnValue({ runtime });
  mocks.read.mockResolvedValue({ status: "not-linked", wallet: null, items: [], hasMore: false, nextCursor: null });
});
afterEach(() => vi.unstubAllEnvs());
function privateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache"); expect(response.headers.get("vary")).toContain("Cookie");
}
describe("portfolio GET with mocked authenticated/service boundaries (not live chain)", () => {
  it("passes only session identity, server runtime and parsed pagination; no-link response is private", async () => {
    const req = request("?limit=2"), response = await GET(req);
    expect(response.status).toBe(200); privateHeaders(response); expect(await response.json()).toMatchObject({ status: "not-linked", wallet: null });
    expect(mocks.auth).toHaveBeenCalledWith(req, false);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({ userId: "current_user", runtime, query: { limit: 2 }, signal: req.signal });
    expect(mocks.rate).toHaveBeenCalledWith("portfolio-ip", 60, 60_000);
    expect(mocks.rate).toHaveBeenCalledWith("solana:portfolio:user:current_user", 20, 60_000);
  });
  it("requires authentication before configuration/service work", async () => {
    mocks.auth.mockRejectedValue(new ApiError(401, "AUTHENTICATION_REQUIRED", "secret"));
    const response = await GET(request()); expect(response.status).toBe(401); privateHeaders(response);
    expect(mocks.configuration).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("fails closed on disabled catalog or invalid server runtime", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "false");
    let response = await GET(request()); expect(response.status).toBe(503); privateHeaders(response);
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
    mocks.configuration.mockImplementation(() => { throw new ApiError(503, "SOLANA_UNAVAILABLE", "private RPC"); });
    response = await GET(request()); expect(response.status).toBe(503); privateHeaders(response);
    expect(await response.text()).not.toContain("private RPC"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["?wallet=other", "?userId=other", "?rpc=evil", "?network=devnet", "?limit=21", "?limit=1&limit=2", "?cursor=bad"])("rejects request selection/query %s", async query => {
    const response = await GET(request(query)); expect(response.status).toBe(400); privateHeaders(response); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([1, 2])("stops at rate limit %s with retry-after", async call => {
    if (call === 2) mocks.rate.mockResolvedValueOnce(undefined);
    mocks.rate.mockRejectedValueOnce(new RateLimitError(8));
    const response = await GET(request()); expect(response.status).toBe(429); privateHeaders(response);
    expect(response.headers.get("retry-after")).toBe("8"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("preserves exact amount strings and per-market unavailable outcomes", async () => {
    const result = { status: "linked", wallet: { balance: { amount: "18446744073709551615" } },
      items: [{ marketId: "7", status: "unavailable", code: "MARKET_STATE_UNAVAILABLE" }], hasMore: true, nextCursor: "opaque" };
    mocks.read.mockResolvedValue(result); const response = await GET(request());
    expect(response.status).toBe(200); privateHeaders(response); expect(await response.json()).toEqual(result);
  });
  it.each([new ApiError(503, "PORTFOLIO_UNAVAILABLE", "secret RPC"), new Error("secret SQL")])("sanitizes service errors with private headers", async error => {
    mocks.read.mockRejectedValue(error); const response = await GET(request());
    expect(response.status).toBe(error instanceof ApiError ? 503 : 500); privateHeaders(response); expect(await response.text()).not.toContain("secret");
  });
});
