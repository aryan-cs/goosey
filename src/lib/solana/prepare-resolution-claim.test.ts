import { address, getAddressEncoder, getProgramDerivedAddress, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyResolutionAddresses } from "./resolution-client";
import { prepareResolutionClaim } from "./prepare-resolution-claim";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), receipt: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.receipt(args, options) }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const payer = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W") as Address, signTransactions: mocks.sign };
const targetWallet: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), seats = address("SysvarRent111111111111111111111111111111111");
const input = () => ({ runtime: { ...runtime }, payer: { ...payer }, targetWallet, marketId: 7n });
const lifetime = () => ({ context: { slot: 503n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } });
async function snapshot() {
  const a = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n, wallet: targetWallet });
  const r = await deriveGooseyResolutionAddresses({ programAddress: runtime.programAddress, marketId: 7n });
  return { ...a, seats, wallet: targetWallet, registered: true, finalizedSlot: 500n,
    marketState: { seats }, seat: { index: 255, yes: 0n, no: 3n, nextNonce: 123n },
    resolution: { address: r.resolution, market: a.market, phase: 3, outcome: 0 },
    orderBook: { book: r.book, market: a.market, seats, reservesReconciled: true } };
}
beforeEach(async () => {
  vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot());
  mocks.receipt.mockResolvedValue({ context: { slot: 502n }, value: null });
  mocks.genesis.mockResolvedValue(runtime.genesisHash); mocks.latest.mockResolvedValue(lifetime());
});
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

describe("resolution claim preparation (mocked finalized reads, real PDA/ABI builders; no RPC execution proof)", () => {
  it("reads target rather than permissionless payer; binds index/receipt and has only payer signer", async () => {
    const result = await prepareResolutionClaim(input());
    const contract: PreparedWalletTransaction = result;
    expect(contract.sender).toBe(payer.address);
    expect(mocks.read).toHaveBeenCalledWith(runtime, { marketId: 7n, wallet: targetWallet }, expect.objectContaining({ includeResolution: true }));
    const index = new Uint8Array(4); new DataView(index.buffer).setUint32(0, 255, true);
    const [receipt] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
      seeds: ["resolution_claim", getAddressEncoder().encode(result.market), index] });
    expect(result).toMatchObject({ payer: payer.address, targetWallet, seatIndex: 255, receipt, observedSlot: 500n, receiptObservedSlot: 502n });
    expect(getSignersFromTransactionMessage(result.message).map(s => s.address)).toEqual([payer.address]);
    expect(result.message.feePayer.address).toBe(payer.address);
    const ix = result.message.instructions[0]!;
    expect(result.message.instructions).toHaveLength(1);
    expect(ix.accounts!.map(a => a.address)).toEqual([payer.address, result.market, seats,
      (await snapshot()).orderBook.book, result.resolution, receipt, (await snapshot()).vault, "11111111111111111111111111111111"]);
    const bytes = new Uint8Array(ix.data!);
    expect(bytes.length).toBe(12); expect(new DataView(bytes.buffer).getUint32(8, true)).toBe(255);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("global:claim_resolution"));
    expect(bytes.slice(0, 8)).toEqual(new Uint8Array(digest).slice(0, 8));
    expect(mocks.receipt.mock.calls[0]![0]).toEqual([receipt, { commitment: "finalized", encoding: "base64", minContextSlot: 500n }]);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 502n }]);
    expect(result.message.lifetimeConstraint).toEqual(lifetime().value);
    expect(result).not.toHaveProperty("expectedNonce");
  });
  it("permits zero holdings/zero payout and owner paying own claim", async () => {
    const state = await snapshot(); state.seat.no = 0n; mocks.read.mockResolvedValue(state);
    const result = await prepareResolutionClaim({ ...input(), payer: { ...payer, address: targetWallet } });
    expect(result.sender).toBe(targetWallet);
  });
  it.each([0, 1, 2, 4])("rejects phase %i", async phase => {
    const state = await snapshot(); state.resolution.phase = phase; mocks.read.mockResolvedValue(state);
    await expect(prepareResolutionClaim(input())).rejects.toThrow("Resolved"); expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it("rejects missing or mismatched verified target accounts", async () => {
    for (const patch of [{ registered: false }, { seat: null }, { resolution: null }, { orderBook: null },
      { wallet: payer.address }, { locator: seats }, { market: seats }, { config: seats }, { vault: seats },
      { seats: payer.address }, { finalizedSlot: -1n }, { finalizedSlot: 500 }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch });
      await expect(prepareResolutionClaim(input())).rejects.toThrow();
    }
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it("rejects inconsistent book/resolution bindings", async () => {
    for (const patch of [{ book: seats }, { market: seats }, { seats: payer.address }, { reservesReconciled: false }]) {
      const state = await snapshot(); Object.assign(state.orderBook, patch); mocks.read.mockResolvedValue(state);
      await expect(prepareResolutionClaim(input())).rejects.toThrow();
    }
    for (const patch of [{ address: seats }, { market: seats }]) {
      const state = await snapshot(); Object.assign(state.resolution, patch); mocks.read.mockResolvedValue(state);
      await expect(prepareResolutionClaim(input())).rejects.toThrow();
    }
  });
  it.each([-1, 256, 1.5])("rejects invalid chain seat index %i", async index => {
    const state = await snapshot(); state.seat.index = index; mocks.read.mockResolvedValue(state);
    await expect(prepareResolutionClaim(input())).rejects.toThrow("seat index");
  });
  it.each([{}, { owner: payer.address }, { lamports: 0n }])("rejects any existing canonical receipt %#", async value => {
    mocks.receipt.mockResolvedValue({ context: { slot: 502n }, value });
    await expect(prepareResolutionClaim(input())).rejects.toThrow("already exists"); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each([499n, -1n, 502])("rejects invalid receipt context %s", async slot => {
    mocks.receipt.mockResolvedValue({ context: { slot }, value: null });
    await expect(prepareResolutionClaim(input())).rejects.toThrow("receipt slot");
  });
  it("rejects network drift and malformed/stale signing lifetimes", async () => {
    mocks.genesis.mockResolvedValue("wrong"); await expect(prepareResolutionClaim(input())).rejects.toThrow("genesis changed");
    expect(mocks.latest).not.toHaveBeenCalled(); mocks.genesis.mockResolvedValue(runtime.genesisHash);
    for (const response of [{ ...lifetime(), context: { slot: 501n } }, { ...lifetime(), context: { slot: 503 } },
      { ...lifetime(), value: { blockhash: "bad", lastValidBlockHeight: 900n } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } }]) {
      mocks.latest.mockResolvedValue(response); await expect(prepareResolutionClaim(input())).rejects.toThrow();
    }
  });
  it("copies inputs before await and ignores caller seat/nonce/destination overrides", async () => {
    const value = { ...input(), seatIndex: 0, expectedNonce: 0n, destination: payer.address };
    const pending = prepareResolutionClaim(value);
    value.marketId = 9n; value.targetWallet = payer.address; value.runtime.genesisHash = "wrong";
    value.payer = { ...payer, address: seats };
    const result = await pending;
    expect(result).toMatchObject({ targetWallet, seatIndex: 255, sender: payer.address, genesisHash: runtime.genesisHash });
  });
  it("rejects signer address mutation during reads or signing lifetime", async () => {
    for (const boundary of [mocks.read, mocks.latest]) {
      const value = input(); const state = await snapshot();
      boundary.mockImplementationOnce(async () => { value.payer.address = seats; return boundary === mocks.read ? state : lifetime(); });
      await expect(prepareResolutionClaim(value)).rejects.toThrow(/bindings changed|Payer changed/);
    }
  });
  it("propagates RPC errors without retry or sending", async () => {
    for (const boundary of [mocks.read, mocks.receipt, mocks.genesis, mocks.latest]) {
      boundary.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(prepareResolutionClaim(input())).rejects.toThrow("RPC unavailable");
    }
  });
  it("rejects invalid market/network before reading", async () => {
    for (const marketId of [-1n, 1n << 64n, 1 as unknown as bigint]) {
      await expect(prepareResolutionClaim({ ...input(), marketId })).rejects.toThrow("market ID");
    }
    await expect(prepareResolutionClaim({ ...input(), runtime: { ...runtime, cluster: "mainnet" as "localnet" } })).rejects.toThrow("mainnet");
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("honors abort before and during requests and threads the same signal", async () => {
    const before = new AbortController(); before.abort(new Error("Canceled"));
    await expect(prepareResolutionClaim({ ...input(), signal: before.signal })).rejects.toThrow("Canceled");
    expect(mocks.read).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.latest.mockImplementationOnce(async () => { during.abort(new Error("Canceled in flight")); return lifetime(); });
    await expect(prepareResolutionClaim({ ...input(), signal: during.signal })).rejects.toThrow("Canceled in flight");
    expect(mocks.read.mock.calls[0]![2].signal).toBe(during.signal);
    expect(mocks.receipt.mock.calls[0]![1].abortSignal).toBe(during.signal);
    expect(mocks.latest.mock.calls[0]![1].abortSignal).toBe(during.signal);
  });
});
