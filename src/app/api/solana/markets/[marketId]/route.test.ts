import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { RateLimitError } from "@/lib/security";
const mocks = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), rate: vi.fn(), genesis: vi.fn(), terms: vi.fn() }));
vi.mock("@/lib/solana/market-terms-store", () => ({ readRetainedMarketTerms: mocks.terms }));
vi.mock("@/lib/security", () => ({ enforceRateLimit: mocks.rate, requestRateLimitKey: () => "test-rate-key",
  RateLimitError: class extends Error { constructor(public retryAfterSeconds: number) { super(); } } }));
vi.mock("@/lib/solana/escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }) }) }));
const program = "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q";
const genesis = "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
const run = (id = "0", query = `wallet=${program}`) => GET(new NextRequest(`http://localhost:8080/api/solana/markets/${id}?${query}`),
  { params: Promise.resolve({ marketId: id }) });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet");
  vi.stubEnv("GOOSEY_SOLANA_TERMS_DIRECTORY", "");
  mocks.resolve.mockReturnValue({ cluster: "localnet", genesisHash: genesis, programAddress: program, rpcUrl: "http://private-rpc.invalid/key" });
  mocks.genesis.mockResolvedValue(genesis);
  // Explicit mocked route fixture, not an executed market or chain-read proof.
  mocks.read.mockResolvedValue({ market: program, config: program, featherMint: program, finalizedSlot: 100n,
    marketState: { creator: program, payoutMilli: 1000n, feeBps: 25, closesAt: 1000n, resolvesAt: 2000n },
    resolution: { phase: "OPEN" }, orderBook: { book: program, revision: 9n, bids: [], asks: [] },
    marketTerms: { address: program, version: 1, digest: new Uint8Array(32).fill(1), manifestLength: 300,
      sealed: true, acceptanceBits: 3, proposer: { wallet: program }, approver: { wallet: program } },
    registered: false, seat: null, walletTokenAmount: null, vaultAmount: 9007199254740993n, vaultSurplus: 0n });
});
afterEach(() => vi.unstubAllEnvs());
describe("finalized chain-market read boundary", () => {
  it("serializes exact values, pins network, and requests one complete terms/book snapshot", async () => {
    const response = await run("18446744073709551615");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ source: "solana", marketId: "18446744073709551615", finalizedSlot: "100",
      exchangeVerified: false, manifestVerified: false, wallet: { registered: false, tokenAmount: null },
      vault: { amount: "9007199254740993" }, terms: { digestHex: "01".repeat(32) } });
    expect(JSON.stringify(body)).not.toContain("private-rpc");
    expect(mocks.read.mock.calls[0][1]).toEqual({ marketId: 18446744073709551615n, wallet: program });
    expect(mocks.read.mock.calls[0][2]).toMatchObject({ includeMarketTerms: true });
    expect(mocks.genesis).toHaveBeenCalledOnce();
  });
  it.each(["-1", "01", "1e2", "1.0", "18446744073709551616", " ", "9".repeat(100)])("rejects invalid ID %s before RPC", async id => {
    expect((await run(id)).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["", "wallet=bad", `wallet=${program}&wallet=${program}`, `wallet=${program}&rpc=http://evil.invalid`,
    "wallet=11111111111111111111111111111111"])("rejects invalid query %s", async query => {
    expect((await run("1", query)).status).toBe(400); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not read RPC while disabled", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", ""); expect((await run()).status).toBe(503);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("honors throttling before RPC", async () => {
    mocks.rate.mockRejectedValue(new RateLimitError(12)); const response = await run();
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("12");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["read", "resolve", "genesis"] as const)("sanitizes %s failure with no fallback", async stage => {
    mocks[stage].mockImplementation(() => { throw new Error("private-rpc secret"); });
    const response = await run(); expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret");
  });
  it("rejects changed genesis", async () => {
    mocks.genesis.mockResolvedValue(program); expect((await run()).status).toBe(503);
  });
  it.each(["marketTerms", "orderBook", "resolution"])("refuses an incomplete %s snapshot", async field => {
    const snapshot = await mocks.read(); mocks.read.mockResolvedValue({ ...snapshot, [field]: null });
    expect((await run()).status).toBe(503);
  });
  it.each(["format=json", "format=terms&format=terms", "format=../secret"])("rejects invalid format %s", async suffix => {
    expect((await run("0", `wallet=${program}&${suffix}`)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not fall back to a mutable manifest when retention is unconfigured", async () => {
    const response = await run("0", `wallet=${program}&format=terms`);
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("TERMS_UNAVAILABLE");
    expect(mocks.terms).not.toHaveBeenCalled();
  });
  it("serves retained UTF8 exactly with same-snapshot commitment and economics", async () => {
    vi.stubEnv("GOOSEY_SOLANA_TERMS_DIRECTORY", "/private/terms");
    // Only verifies byte-preserving route delivery: store separately verifies a full real manifest.
    const exact = '{"question":"Will 🪶 win?","value":"1000"}';
    mocks.terms.mockResolvedValue({ bytes: new TextEncoder().encode(exact), digest: "01".repeat(32) });
    const response = await run("0", `wallet=${program}&format=terms`);
    expect(response.status).toBe(200); expect(await response.text()).toBe(exact);
    expect(response.headers.get("x-goosey-terms-digest")).toBe("01".repeat(32));
    expect(response.headers.get("x-goosey-finalized-slot")).toBe("100");
    expect(response.headers.get("x-goosey-terms-sealed")).toBe("true");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.terms).toHaveBeenCalledWith("/private/terms", expect.objectContaining({ digest: "01".repeat(32),
      manifestLength: 300, binding: expect.objectContaining({ genesisHash: genesis, marketId: "0", program }),
      economics: { payoutMilli: "1000", feeBps: "25", closesAt: "1000", resolvesAt: "2000", decimals: 3 } }));
  });
  it("sanitizes missing/corrupt retained file errors without disclosing paths", async () => {
    vi.stubEnv("GOOSEY_SOLANA_TERMS_DIRECTORY", "/private/terms");
    mocks.terms.mockRejectedValue(new Error("corrupt /private/terms"));
    const response = await run("0", `wallet=${program}&format=terms`);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("/private");
  });
});
