import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, address } from "@solana/kit";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { encodeMarketTerms, hashMarketTerms, type MarketTerms } from "./market-terms";
import { loadChainMarket } from "./market-view";
const mocks = vi.hoisted(() => ({ read: vi.fn(), genesis: vi.fn(), fetch: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }) }),
}));
let fixture: MarketTerms;
beforeAll(async () => {
  const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), enc = getAddressEncoder();
  const pda = async (seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
  const config = await pda(["config"]), id = new Uint8Array(8); id[0] = 7;
  const wallet = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
  const reviewer = async (n: number) => ({ wallet: wallet(n), enrollment: await pda(["enrollment", enc.encode(config), enc.encode(wallet(n))]) });
  fixture = { version: 1, binding: { cluster: "localnet", genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm", program, config,
    market: await pda(["market", enc.encode(config), id]), marketId: "7", creator: wallet(1), featherMint: await pda(["feather_mint", enc.encode(config)]) },
    question: "Offline codec test: is the published integer at least 10?",
    rules: { yes: "YES if the selected record is an integer greater than or equal to 10.",
      no: "NO if the selected record is an integer less than 10.", void: "VOID if no valid integer is available by the resolution deadline." },
    observation: { startsAt: "100", endsAt: "200", timezone: "UTC" },
    sources: [{ id: "primary", uri: "https://example.invalid/record", selection: "Select the record timestamped 200; this is an offline test specification.", snapshotSha256: null }],
    sourcePolicy: { priority: "array-order-first-authoritative", missing: "Absent records are unavailable; apply the stated VOID criterion.", revisions: "Use the latest revision published no later than 220." },
    economics: { payoutMilli: "1000", feeBps: "100", closesAt: "150", resolvesAt: "220", decimals: 3 },
    oracle: { kind: "two-reviewer-no-fallback-v1", proposer: await reviewer(2), approver: await reviewer(3),
      unavailable: "wait-for-designated-reviewers", replacement: "none", automaticVoid: false } };
});

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999", programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const wallet = getAddressDecoder().decode(new Uint8Array(32).fill(4));
let api: Record<string, unknown>, bytes: Uint8Array;
beforeEach(async () => {
  vi.resetAllMocks();
  bytes = encodeMarketTerms(fixture);
  const digest = await hashMarketTerms(bytes);
  const commitment = { address: fixture.binding.market, version: 1, manifestLength: bytes.length,
    digest: Uint8Array.from(digest.match(/../g)!.map(n => parseInt(n,16))), proposer: fixture.oracle.proposer, approver: fixture.oracle.approver, sealed: true, acceptanceBits: 3 };
  mocks.read.mockResolvedValue({ config: fixture.binding.config, market: fixture.binding.market, featherMint: fixture.binding.featherMint,
    wallet, finalizedSlot: 101n, orderBook: { reservesReconciled: true }, resolution: { phase: 0 }, marketTerms: commitment,
    marketState: { marketId: 7n, creator: fixture.binding.creator, payoutMilli: 1000n, feeBps: 100, closesAt: 150n, resolvesAt: 220n } });
  api = { version: 1, source: "solana", commitment: "finalized", exchangeVerified: false, manifestVerified: false,
    ...runtime, programAddress: runtime.programAddress, marketId: "7", marketAddress: fixture.binding.market, finalizedSlot: "100", wallet: { address: wallet },
    terms: { address: commitment.address, version: 1, manifestLength: bytes.length, digestHex: digest } };
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.fetch.mockImplementation(async (url: string) => url.includes("format=terms")
    ? new Response(new Uint8Array(bytes)) : Response.json(api));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
const load = (signal?: AbortSignal) => loadChainMarket(runtime, 7n, wallet, signal);
describe("chain market view (mocked transport, real canonical terms verification)", () => {
  it("returns actual finalized chain economics and verified canonical manifest", async () => {
    api.market = { payoutMilli: "999999", availableCash: "999999" };
    const result = await load();
    expect(result.snapshot.marketState.payoutMilli).toBe(1000n);
    expect(result.terms).toEqual(fixture);
    expect(mocks.read).toHaveBeenCalledWith({...runtime,rpcUrl:runtime.rpcUrl+"/"}, {marketId:7n,wallet}, expect.objectContaining({includeMarketTerms:true}));
    expect(mocks.fetch.mock.calls[1][0]).toContain("&format=terms");
  });
  it.each(["genesisHash", "marketId", "programAddress", "commitment", "source"])("rejects API %s substitution", async field => {
    api[field] = "wrong"; await expect(load()).rejects.toThrow("identity"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects a substituted wallet", async () => { api.wallet={address:fixture.binding.creator}; await expect(load()).rejects.toThrow("identity"); });
  it("requires API slot no newer than independent finalized read", async () => { api.finalizedSlot="102"; await expect(load()).rejects.toThrow("freshness"); });
  it("rejects manifest commitment tampering", async () => { (api.terms as Record<string,unknown>).digestHex="00".repeat(32); await expect(load()).rejects.toThrow("commitment"); });
  it("rejects changed terms bytes, even if syntactically valid", async () => { bytes=encodeMarketTerms({...fixture,question:fixture.question.replace("10", "11")}); await expect(load()).rejects.toThrow("digest"); });
  it("rejects noncanonical manifest serialization", async () => { bytes=new TextEncoder().encode(JSON.stringify(fixture,null,2)); await expect(load()).rejects.toThrow(); });
  it("rejects API unavailable instead of using a database fallback", async () => { mocks.fetch.mockResolvedValue(new Response("unavailable",{status:503})); await expect(load()).rejects.toThrow("unavailable"); });
  it("rejects changed RPC genesis at completion", async () => { mocks.genesis.mockResolvedValue("wrong"); await expect(load()).rejects.toThrow("genesis"); });
  it("honors already-aborted selection", async () => { const c=new AbortController(); c.abort(); await expect(load(c.signal)).rejects.toThrow(); expect(mocks.fetch).not.toHaveBeenCalled(); });
  it("rejects economics changed on-chain despite API matching old terms", async () => { const state=await mocks.read(); state.marketState.payoutMilli=2000n; await expect(load()).rejects.toThrow("economics"); });
});
