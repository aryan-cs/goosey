import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ user: vi.fn(), limit: vi.fn(), register: vi.fn(), publish: vi.fn(), session: vi.fn() }));
// Mock only authentication/storage/RPC boundaries. Keep real request parsing,
// metadata validation, runtime validation and API response serialization.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/market-service", async original => ({ ...await original<typeof import("@/lib/market-service")>(),
  requireUser: mock.user, consumeRateLimit: mock.limit }));
vi.mock("@/lib/mutation-session", () => ({ assertMutationSession: mock.session }));
vi.mock("@/lib/solana/market-catalog", async original => ({ ...await original<typeof import("@/lib/solana/market-catalog")>(),
  registerSolanaMarket: mock.register, publishSolanaMarket: mock.publish }));
import { ApiError } from "@/lib/market-service";
import { PATCH, POST } from "./route";
afterEach(() => vi.unstubAllEnvs());

const body = () => ({ chainMarketId: "7", metadata: { slug: "reviewed-chain-market", shortTitle: "Reviewed question",
  description: "Explicit editorial description for the reviewed market.", category: "Hackathon" } });
const request = (value: unknown = body(), contentType = "application/json") => new NextRequest("http://localhost:8080/api/admin/solana/markets", {
  method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(value),
});
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet"); vi.stubEnv("GOOSEY_SOLANA_RPC_URL", "http://127.0.0.1:20999");
  vi.stubEnv("GOOSEY_SOLANA_PROGRAM_ID", "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
  vi.stubEnv("GOOSEY_SOLANA_GENESIS_HASH", "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE");
  vi.stubEnv("GOOSEY_SOLANA_TERMS_DIRECTORY", "/private/operator-terms");
  vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "");
  mock.user.mockResolvedValue({ id: "admin", role: "ADMIN", status: "ACTIVE" });
  mock.register.mockResolvedValue({ created: true, market: { id: "catalog", slug: "reviewed-chain-market", title: "Question?",
    status: "DRAFT", executionBackend: "SOLANA", collateralAccountId: null, volumeMilli: 0n },
  binding: { cluster: "localnet", genesisHash: process.env.GOOSEY_SOLANA_GENESIS_HASH,
    programAddress: process.env.GOOSEY_SOLANA_PROGRAM_ID, marketAddress: "public-market", chainMarketId: "7", market: { privateField: true } } });
});
describe("administrator chain catalog registration HTTP", () => {
  it("keeps publication off unless explicitly enabled", async () => {
    expect((await PATCH(request())).status).toBe(503);
    expect(mock.publish).not.toHaveBeenCalled(); expect(mock.register).not.toHaveBeenCalled();
  });
  it("routes explicit enabled publication through verified publication, not registration", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
    // Use the resolved registration fixture only to construct this response mock.
    const fixture = await mock.register(); mock.register.mockClear();
    mock.publish.mockResolvedValue({ ...fixture, created: false, market: { ...fixture.market, status: "OPEN" } });
    const response = await PATCH(request());
    expect(response.status).toBe(200); expect((await response.json()).market.status).toBe("OPEN");
    expect(mock.publish).toHaveBeenCalledOnce(); expect(mock.register).not.toHaveBeenCalled();
    const input = mock.publish.mock.calls[0][0]; await input.authorize({}); expect(mock.session).toHaveBeenCalledOnce();
  });
  it("uses only server-selected runtime, authenticated actor and a strict public response", async () => {
    const req = request(), response = await POST(req), result = await response.json();
    expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mock.user).toHaveBeenCalledWith(req, true);
    const input = mock.register.mock.calls[0][0];
    expect(input).toMatchObject({ actorUserId: "admin", chainMarketId: 7n,
      termsDirectory: "/private/operator-terms", runtime: { rpcUrl: "http://127.0.0.1:20999/" } });
    const tx = {}; await input.authorize(tx); expect(mock.session).toHaveBeenCalledWith(tx, req, "admin");
    expect(result.market).not.toHaveProperty("volumeMilli"); expect(result.market).not.toHaveProperty("collateralAccountId");
    expect(result.binding).not.toHaveProperty("market");
  });
  it("returns 200 for exact idempotent replay", async () => {
    mock.register.mockResolvedValue({ ...await mock.register(), created: false });
    expect((await POST(request())).status).toBe(200);
  });
  it.each(["", "foo", "01", "-1", "1.0", "18446744073709551616", 7])("rejects invalid canonical u64 %s", async id => {
    expect((await POST(request({ ...body(), chainMarketId: id }))).status).toBe(400);
    expect(mock.register).not.toHaveBeenCalled();
  });
  it.each(["actorUserId", "rpcUrl", "runtime", "termsDirectory", "status", "collateralAccountId"])("rejects client trust-boundary override %s", async key => {
    expect((await POST(request({ ...body(), [key]: "injected" }))).status).toBe(400);
    expect(mock.register).not.toHaveBeenCalled();
  });
  it.each(["GOOSEY_SOLANA_CLUSTER", "GOOSEY_SOLANA_RPC_URL", "GOOSEY_SOLANA_PROGRAM_ID", "GOOSEY_SOLANA_GENESIS_HASH", "GOOSEY_SOLANA_TERMS_DIRECTORY"])("fails closed without %s", async key => {
    vi.stubEnv(key, ""); expect((await POST(request())).status).toBe(503);
    expect(mock.register).not.toHaveBeenCalled();
  });
  it("preserves authentication refusal before parsing or RPC", async () => {
    mock.user.mockRejectedValue(new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in."));
    expect((await POST(request())).status).toBe(401); expect(mock.limit).not.toHaveBeenCalled();
    expect(mock.register).not.toHaveBeenCalled();
  });
  it.each([{ role: "USER", status: "ACTIVE" }, { role: "ADMIN", status: "SUSPENDED" }])("refuses non-administrators and inactive administrators: %s", async user => {
    mock.user.mockResolvedValue({ id: "actor", ...user });
    expect((await POST(request())).status).toBe(403);
    expect(mock.limit).not.toHaveBeenCalled(); expect(mock.register).not.toHaveBeenCalled();
  });
  it("preserves bounded rate-limit retry response", async () => {
    mock.limit.mockRejectedValue(new ApiError(429, "RATE_LIMITED", "Wait.", { retryAfter: 60 }));
    const response = await POST(request()); expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60"); expect(mock.register).not.toHaveBeenCalled();
  });
  it("propagates revoked-session refusal without a success response", async () => {
    mock.register.mockRejectedValue(new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in."));
    expect((await POST(request())).status).toBe(401);
  });
  it("enforces JSON content type and body size", async () => {
    expect((await POST(request(body(), "text/plain"))).status).toBe(400);
    expect((await POST(request({ ...body(), padding: "x".repeat(20_000) }))).status).toBe(400);
    expect(mock.register).not.toHaveBeenCalled();
  });
});
