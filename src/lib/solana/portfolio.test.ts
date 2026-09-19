import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ links: vi.fn(), startup: vi.fn(), catalog: vi.fn(), balance: vi.fn(), escrow: vi.fn(), genesis: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { solanaWalletLink: { findMany: mocks.links } }, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("./catalog-read", async original => ({ ...await original<typeof import("./catalog-read")>(), readSolanaCatalog: mocks.catalog }));
vi.mock("./wallet-balance", () => ({ readGooseyWalletBalance: mocks.balance }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.escrow }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }) }) }));
import { parsePortfolioQuery, readSolanaPortfolio } from "./portfolio";
import { DEVNET_GENESIS_HASH } from "./runtime";

// Mock verified reader boundaries: unit orchestration/serialization, not chain proof.
const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = address("SysvarRent111111111111111111111111111111111");
const runtime = { cluster: "localnet" as const, programAddress: program, rpcUrl: "http://127.0.0.1:1/?private=secret",
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const item = (id = "7") => ({ chain: { marketId: id, marketAddress: program }, title: "Unit reader boundary fixture", slug: "unit-fixture", href: `/chain/markets/${id}` });
const seat = () => ({ index: 1, availableCash: 18446744073709551615n, reservedCash: 100n, yes: 20n, no: 10n,
  reservedYes: 2n, reservedNo: 1n, nextNonce: 9007199254740993n, everTraded: true });
const snapshot = () => ({ market: program, seat: seat(), finalizedSlot: 9007199254740995n,
  orderBook: {}, resolution: { phase: 0 }, marketTerms: {}, walletTokenAmount: 777n });
const run = (query: Record<string, unknown> = {}) => readSolanaPortfolio({ userId: "current_user", runtime, query });
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  mocks.links.mockResolvedValue([{ walletAddress: wallet }]); mocks.startup.mockResolvedValue(undefined);
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.catalog.mockResolvedValue({ items: [item()], hasMore: false, nextCursor: null });
  mocks.balance.mockResolvedValue({ mint: program, walletTokens: program, featherAmount: 9007199254740993n,
    featherDecimals: 3, featherAccountStatus: "present", observedSlot: 9007199254740994n });
  mocks.escrow.mockResolvedValue(snapshot());
});
afterEach(() => vi.unstubAllEnvs());

describe("portfolio service with mocked SQL/RPC reader boundaries", () => {
  it("selects only current user's exact chain link, canonical catalog and full finalized reader", async () => {
    const result = await run();
    expect(mocks.startup).toHaveBeenCalledOnce();
    expect(mocks.links).toHaveBeenCalledExactlyOnceWith({ where: { userId: "current_user", chainId: "solana:localnet", genesisHash: runtime.genesisHash },
      select: { walletAddress: true }, take: 2 });
    expect(mocks.catalog).toHaveBeenCalledExactlyOnceWith(runtime, { limit: 10 });
    expect(mocks.escrow).toHaveBeenCalledExactlyOnceWith(runtime, { marketId: 7n, wallet }, { signal: expect.any(AbortSignal), includeMarketTerms: true });
    expect(result).toMatchObject({ status: "linked", scope: "published-catalog-page", wallet: { address: wallet,
      balance: { amount: "9007199254740993", decimals: 3, finalizedSlot: "9007199254740994" } }, items: [{
      status: "available", registered: true, finalizedSlot: "9007199254740995", seat: {
        availableCash: "18446744073709551615", reservedCash: "100", yes: "20", reservedYes: "2", nextNonce: "9007199254740993" } }] });
    const text = JSON.stringify(result);
    expect(text).not.toContain("rpcUrl"); expect(text).not.toContain("secret"); expect(text).not.toContain("777");
    expect(text).not.toContain("totalBalance"); expect(mocks.genesis).toHaveBeenCalledTimes(2);
  });
  it("not linked is explicit and does not read catalog/RPC or invent a zero balance", async () => {
    mocks.links.mockResolvedValue([]);
    expect(await run()).toMatchObject({ status: "not-linked", wallet: null, items: [], nextCursor: null });
    expect(mocks.catalog).not.toHaveBeenCalled(); expect(mocks.balance).not.toHaveBeenCalled(); expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it.each([{ links: [{ walletAddress: "invalid" }] }, { links: [{ walletAddress: program }, { walletAddress: wallet }] }, { links: [{ walletAddress: "11111111111111111111111111111111" }] }])("fails closed on invalid/non-single link %j", async ({ links }) => {
    mocks.links.mockResolvedValue(links); await expect(run()).rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" });
    expect(mocks.catalog).not.toHaveBeenCalled();
  });
  it.each([undefined, "false", "TRUE"])("requires exact catalog gate %s", async flag => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", flag);
    await expect(run()).rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" }); expect(mocks.startup).not.toHaveBeenCalled();
  });
  it("rejects invalid pinned runtime before database/RPC", async () => {
    await expect(readSolanaPortfolio({ userId: "u", runtime: { ...runtime, rpcUrl: "http://remote.invalid" }, query: {} }))
      .rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" }); expect(mocks.startup).not.toHaveBeenCalled();
  });
  it("selects a devnet link only for the full official pinned genesis", async () => {
    const deployment = { ...runtime, cluster: "devnet" as const, rpcUrl: "https://unit.invalid", genesisHash: DEVNET_GENESIS_HASH };
    mocks.genesis.mockResolvedValue(DEVNET_GENESIS_HASH);
    await readSolanaPortfolio({ userId: "current_user", runtime: deployment, query: {} });
    expect(mocks.links).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "current_user", chainId: "solana:devnet", genesisHash: DEVNET_GENESIS_HASH } }));
    await expect(readSolanaPortfolio({ userId: "current_user", runtime: { ...deployment, genesisHash: runtime.genesisHash }, query: {} }))
      .rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" });
  });
  it("refuses changed genesis without returning previously fetched amounts", async () => {
    mocks.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce("wrong");
    await expect(run()).rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" });
  });
  it("refuses initial genesis failure before reading balances", async () => {
    mocks.genesis.mockRejectedValue(new Error("secret provider"));
    await expect(run()).rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" }); expect(mocks.balance).not.toHaveBeenCalled();
  });
  it("does not substitute SQL state when canonical catalog or startup fails", async () => {
    mocks.catalog.mockRejectedValue(new Error("noncanonical stored binding")); await expect(run()).rejects.toThrow();
    expect(mocks.escrow).not.toHaveBeenCalled();
    mocks.startup.mockRejectedValue(new Error("startup")); await expect(run()).rejects.toThrow("startup");
  });
  it("reports independent wallet and market read failures without amounts or provider details", async () => {
    mocks.catalog.mockResolvedValue({ items: [item("7"), item("8")], hasMore: false, nextCursor: null });
    mocks.balance.mockRejectedValue(new Error("secret endpoint"));
    mocks.escrow.mockRejectedValueOnce(new Error("private provider timeout")).mockResolvedValueOnce(snapshot());
    const result = await run();
    expect(result.wallet).toEqual({ address: wallet, balance: { status: "unavailable", code: "WALLET_BALANCE_UNAVAILABLE" } });
    expect(result.items[0]).toEqual({ ...item().chain, title: item().title, slug: item().slug, href: item().href,
      status: "unavailable", code: "MARKET_STATE_UNAVAILABLE" });
    expect(result.items[1].status).toBe("available"); expect(JSON.stringify(result)).not.toContain("private");
  });
  it("distinguishes a verified absent ATA (zero) from an absent seat (null)", async () => {
    mocks.balance.mockResolvedValue({ mint: program, walletTokens: program, featherAmount: 0n, featherDecimals: 3,
      featherAccountStatus: "absent", observedSlot: 10n });
    mocks.escrow.mockResolvedValue({ ...snapshot(), seat: null });
    const result = await run(); expect(result.wallet).toMatchObject({ balance: { status: "available", amount: "0", accountStatus: "absent" } });
    expect(result.items[0]).toMatchObject({ registered: false, seat: null, status: "available" });
  });
  it.each(["market", "orderBook", "resolution", "marketTerms"])("does not serve incomplete/mismatched %s snapshot", async key => {
    mocks.escrow.mockResolvedValue({ ...snapshot(), [key]: null });
    expect((await run()).items[0]).toMatchObject({ status: "unavailable" });
  });
  it("bounds market concurrency to three and preserves page order and cursor", async () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, createdAt: "2026-09-19T00:00:00.000Z", id: "cursor_id" })).toString("base64url");
    mocks.catalog.mockResolvedValue({ items: Array.from({ length: 20 }, (_, i) => item(String(i))), hasMore: true, nextCursor: cursor });
    let active = 0, maximum = 0;
    mocks.escrow.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return snapshot();
    });
    const result = await run({ limit: "20", cursor });
    expect(maximum).toBe(3); expect(result.items.map(row => row.marketId)).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    expect(result).toMatchObject({ hasMore: true, nextCursor: cursor });
    expect(mocks.catalog).toHaveBeenCalledWith(runtime, { limit: 20, cursor });
  });
  it("empty catalog returns a genuine wallet read with no market calls", async () => {
    mocks.catalog.mockResolvedValue({ items: [], hasMore: false, nextCursor: null });
    const result = await run(); expect(result.items).toEqual([]); expect(result.wallet).toMatchObject({ balance: { status: "available" } });
    expect(mocks.escrow).not.toHaveBeenCalled();
  });
  it("does not execute an over-limit catalog page even if its boundary regresses", async () => {
    mocks.catalog.mockResolvedValue({ items: [item(), item("8")], hasMore: false, nextCursor: null });
    await expect(run({ limit: 1 })).rejects.toMatchObject({ code: "PORTFOLIO_UNAVAILABLE" }); expect(mocks.escrow).not.toHaveBeenCalled();
  });
  it.each([{ limit: "21" }, { limit: "0" }, { limit: "01" }, { limit: "1e1" }, { cursor: "invalid" }, { wallet: wallet }, { rpc: "x" }, { network: "devnet" }])("rejects unsafe pagination/selection %j", query => {
    expect(() => parsePortfolioQuery(query)).toThrow();
  });
  it("pre-aborted requests perform no database work", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readSolanaPortfolio({ userId: "u", runtime, query: {}, signal: controller.signal })).rejects.toThrow();
    expect(mocks.startup).not.toHaveBeenCalled();
  });
});
