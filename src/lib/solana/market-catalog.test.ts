import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSolanaMarket } from "./market-catalog";
import type { TransactionRunner } from "@/lib/serializable-transaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), terms: vi.fn(), genesis: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("./market-terms-store", () => ({ readRetainedMarketTerms: mocks.terms }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }) }) }));
const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesis = "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE";
const input = () => ({ actorUserId: "admin", runtime: { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999",
  programAddress: program, genesisHash: genesis }, termsDirectory: "/private/test-terms", chainMarketId: 7n,
  metadata: { slug: "verified-chain-market", shortTitle: "Chain question", description: "An explicit editorial description for the chain market.", category: "Hackathon" } });
const snapshot = () => ({ config: program, market: program, featherMint: program, finalizedSlot: 123n,
  marketState: { creator: program, payoutMilli: 1000n, feeBps: 25, closesAt: 2_000_000_000n, resolvesAt: 2_000_000_010n },
  marketTerms: { sealed: true, acceptanceBits: 3, digest: new Uint8Array(32).fill(3), manifestLength: 1000,
    proposer: { wallet: program, enrollment: program }, approver: { wallet: program, enrollment: program } },
  orderBook: {}, resolution: { phase: 0 } });
// Mocked trusted reader/store fixtures test catalog orchestration only, not real
// chain commitments. The actual reader and filesystem codecs have separate proofs.
beforeEach(() => {
  vi.resetAllMocks(); mocks.read.mockResolvedValue(snapshot()); mocks.genesis.mockResolvedValue(genesis);
  mocks.terms.mockResolvedValue({ digest: "03".repeat(32), terms: { question: "The exact committed question?",
    rules: { yes: "The specified YES condition.", no: "The specified NO condition.", void: "The specified VOID condition." },
    sources: [{ uri: "https://example.invalid/fixture" }] } });
});
function database() {
  const user = vi.fn().mockResolvedValue({ role: "ADMIN", status: "ACTIVE" });
  const find = vi.fn().mockResolvedValue(null);
  const createMarket = vi.fn().mockImplementation(async ({ data }) => ({ id: "catalog-market", ...data }));
  const createBinding = vi.fn().mockImplementation(async ({ data }) => ({ id: "catalog-binding", ...data }));
  const audit = vi.fn().mockResolvedValue({ id: "audit" });
  // Deliberately no ledger, cash, journal, position or order delegate available.
  const tx = { user: { findUnique: user }, solanaMarketBinding: { findUnique: find, create: createBinding },
    market: { create: createMarket }, auditLog: { create: audit } };
  const transaction = vi.fn(async operation => operation(tx));
  return { client: { $transaction: transaction } as unknown as TransactionRunner, user, find, createMarket, createBinding, audit, transaction };
}
describe("verified chain catalog registration", () => {
  it("creates only a DRAFT metadata row, immutable identity and audit without SQL collateral", async () => {
    const d = database(), result = await registerSolanaMarket(input(), d.client);
    expect(result.created).toBe(true);
    expect(d.createMarket).toHaveBeenCalledWith({ data: expect.objectContaining({ executionBackend: "SOLANA",
      collateralAccountId: null, status: "DRAFT", acceptingOrders: false, pricingModel: "ORDER_BOOK",
      title: "The exact committed question?", payoutMilli: 1000n, feeBps: 25 }) });
    expect(d.createBinding).toHaveBeenCalledWith({ data: { cluster: "localnet", genesisHash: genesis,
      programAddress: program, marketAddress: program, chainMarketId: "7", marketId: "catalog-market" } });
    expect(d.audit).toHaveBeenCalledOnce(); expect(d.user).toHaveBeenCalledTimes(2);
    expect(mocks.read.mock.calls[0][2]).toMatchObject({ includeMarketTerms: true });
    expect(mocks.terms.mock.calls[0][1]).toMatchObject({ manifestLength: 1000, digest: "03".repeat(32),
      binding: { marketId: "7", genesisHash: genesis }, economics: { payoutMilli: "1000", feeBps: "25" } });
  });
  it("is idempotent for identical catalog identity and metadata", async () => {
    const d = database(), first = await registerSolanaMarket(input(), d.client);
    d.find.mockResolvedValue({ ...first.binding, market: first.market });
    expect((await registerSolanaMarket(input(), d.client)).created).toBe(false);
    expect(d.createMarket).toHaveBeenCalledOnce(); expect(d.audit).toHaveBeenCalledOnce();
  });
  it("does not reinterpret an existing domain identity with different metadata", async () => {
    const d = database(), first = await registerSolanaMarket(input(), d.client);
    d.find.mockResolvedValue({ ...first.binding, market: first.market });
    const value = input(); value.metadata.description = "A different editorial description that was not previously registered.";
    await expect(registerSolanaMarket(value, d.client)).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(d.createMarket).toHaveBeenCalledOnce();
  });
  it.each([{ role: "USER", status: "ACTIVE" }, { role: "ADMIN", status: "SUSPENDED" }, null])("requires active admin before RPC: %s", async actor => {
    const d = database(); d.user.mockResolvedValue(actor);
    await expect(registerSolanaMarket(input(), d.client)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(mocks.read).not.toHaveBeenCalled(); expect(d.createMarket).not.toHaveBeenCalled();
  });
  it("rechecks admin privilege after asynchronous chain verification", async () => {
    const d = database(); d.user.mockResolvedValueOnce({ role: "ADMIN", status: "ACTIVE" }).mockResolvedValue(null);
    await expect(registerSolanaMarket(input(), d.client)).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(d.createMarket).not.toHaveBeenCalled();
  });
  it.each(["unsealed", "one-acceptance", "missing-resolution", "missing-book"])("rejects incomplete publication %s", async kind => {
    const s = snapshot();
    if (kind === "unsealed") s.marketTerms.sealed = false;
    if (kind === "one-acceptance") s.marketTerms.acceptanceBits = 1;
    mocks.read.mockResolvedValue({ ...s, ...(kind === "missing-resolution" ? { resolution: null } : {}),
      ...(kind === "missing-book" ? { orderBook: null } : {}) });
    const d = database(); await expect(registerSolanaMarket(input(), d.client)).rejects.toMatchObject({ code: "CHAIN_MARKET_NOT_PUBLISHED" });
    expect(d.createMarket).not.toHaveBeenCalled();
  });
  it.each(["read", "terms", "genesis"] as const)("does not write catalog after %s failure", async method => {
    mocks[method].mockRejectedValue(new Error("offline")); const d = database();
    await expect(registerSolanaMarket(input(), d.client)).rejects.toThrow("offline"); expect(d.createMarket).not.toHaveBeenCalled();
  });
  it("rejects network changes", async () => {
    mocks.genesis.mockResolvedValue(program); const d = database();
    await expect(registerSolanaMarket(input(), d.client)).rejects.toThrow("genesis changed"); expect(d.createMarket).not.toHaveBeenCalled();
  });
  it.each([-1n, 1n << 64n])("rejects market-ID bounds %s", async chainMarketId => {
    const d = database(); await expect(registerSolanaMarket({ ...input(), chainMarketId }, d.client)).rejects.toThrow("market ID");
    expect(d.transaction).not.toHaveBeenCalled();
  });
  it("rejects out-of-range catalog timestamps without rounding", async () => {
    const s = snapshot(); s.marketState.closesAt = 8_640_000_000_001n; mocks.read.mockResolvedValue(s);
    const d = database(); await expect(registerSolanaMarket(input(), d.client)).rejects.toThrow("time"); expect(d.createMarket).not.toHaveBeenCalled();
  });
  it("captures metadata/runtime before async mutation", async () => {
    const value = input(), d = database(), pending = registerSolanaMarket(value, d.client);
    value.metadata.slug = "changed-slug"; value.runtime.genesisHash = "bad"; value.chainMarketId = 9n;
    expect((await pending).market.slug).toBe("verified-chain-market");
  });
  it("maps unique conflicts without adopting or overwriting a different market", async () => {
    const d = database(); d.createMarket.mockRejectedValue({ code: "P2002" });
    await expect(registerSolanaMarket(input(), d.client)).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(d.audit).not.toHaveBeenCalled();
  });
});
