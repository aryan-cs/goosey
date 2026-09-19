import { address, blockhash, getSignersFromTransactionMessage, getProgramDerivedAddress, getAddressEncoder, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { prepareOrder, type PrepareOrderInput } from "./prepare-order";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999", programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const sender = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"), signTransactions: mocks.sign };
const seats = address("SysvarRent111111111111111111111111111111111");
const input = (): PrepareOrderInput => ({ runtime: { ...runtime }, sender, marketId: 7n, price: 40n, quantity: 2n,
  outcome: "YES", action: "BUY", timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
async function snapshot() {
  const p = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n, wallet: sender.address });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, p.market);
  const [resolution] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["resolution", getAddressEncoder().encode(p.market)] });
  const [terms] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["market_terms", getAddressEncoder().encode(p.market)] });
  const reviewers = await Promise.all([address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")].map(async wallet => ({ wallet: wallet as Address,
    enrollment: (await getProgramDerivedAddress({ programAddress: runtime.programAddress, seeds: ["enrollment", getAddressEncoder().encode(p.config), getAddressEncoder().encode(wallet)] }))[0] })));
  return { ...p, seats, wallet: sender.address, registered: true, finalizedSlot: 500n,
    resolution: { address: resolution, phase: 0, creator: seats as Address, proposer: reviewers[0]!, approver: reviewers[1]! },
    marketTerms: { address: terms, market: p.market, creator: seats as Address, sealed: true, acceptanceBits: 3, proposer: { ...reviewers[0]! }, approver: { ...reviewers[1]! } },
    marketState: { payoutMilli: 100n, feeBps: 100 },
    seat: { index: 0, availableCash: 81n, reservedCash: 1000n, yes: 10n, no: 5n,
      reservedYes: 8n, reservedNo: 4n, nextNonce: 9_007_199_254_740_993n, everTraded: true },
    orderBook: { book, market: p.market, seats, payoutMilli: 100n, feeBps: 100, reservesReconciled: true, revision: 12n } };
}
beforeEach(async () => {
  vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot()); mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue({ context: { slot: 501n }, value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 900n } });
});

describe("unsigned order preparation (mocked RPC/snapshot, real instruction builders; not chain proof)", () => {
  it("requires a verified open resolution account rather than silently placing without one", async () => {
    const state = await snapshot();
    for (const resolution of [null, { ...state.resolution, phase: 1 }, { ...state.resolution, phase: 3 }, { ...state.resolution, address: seats }]) {
      mocks.read.mockResolvedValue({ ...state, resolution }); await expect(prepareOrder(input())).rejects.toThrow();
    }
    expect(mocks.latest).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("uses coherent book snapshot nonce/addresses and wallet-only fee payer with conservative compute budget", async () => {
    const prepared = await prepareOrder(input());
    const walletContract: PreparedWalletTransaction = prepared;
    expect(walletContract.message).toBe(prepared.message);
    expect(mocks.read).toHaveBeenCalledWith(runtime, { marketId: 7n, wallet: sender.address }, expect.objectContaining({ includeOrderBook: true, includeResolution: true, includeMarketTerms: true, signal: expect.any(AbortSignal) }));
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 500n }]);
    expect(prepared).toMatchObject({ sender: sender.address, cluster: "localnet", genesisHash: runtime.genesisHash,
      expectedNonce: 9_007_199_254_740_993n, seats, requiredCash: 81n, observedSlot: 500n, blockhashSlot: 501n, bookRevision: 12n });
    expect(prepared.message.feePayer.address).toBe(sender.address);
    expect(getSignersFromTransactionMessage(prepared.message)).toEqual([sender]);
    expect(prepared.message.instructions).toHaveLength(2);
    const [budget, place] = prepared.message.instructions;
    expect(budget!.programAddress).toBe("ComputeBudget111111111111111111111111111111");
    expect(Array.from(budget!.data!)).toEqual([2, 192, 92, 21, 0]);
    expect(place!.programAddress).toBe(runtime.programAddress);
    expect(place!.accounts![3]!.address).toBe(seats);
    expect(place!.accounts).toHaveLength(9);
    expect(place!.accounts![8]).toEqual({ address: (await snapshot()).marketTerms.address, role: 0 });
    const bytes = new Uint8Array(place!.data!), data = new DataView(bytes.buffer);
    expect(data.getBigUint64(8, true)).toBe(9_007_199_254_740_993n);
    expect(data.getBigUint64(16, true)).toBe(40n); expect(bytes.at(-1)).toBe(16);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(prepared.message.lifetimeConstraint).toEqual({ blockhash: runtime.genesisHash, lastValidBlockHeight: 900n });
  });
  it.each([null, { sealed: false }, { acceptanceBits: 0 }, { acceptanceBits: 1 }, { acceptanceBits: 2 }, { acceptanceBits: 4 }, { sealed: 1 }])("rejects absent/unsealed/unaccepted terms %# before signing lifetime", async patch => {
    const state = await snapshot(); mocks.read.mockResolvedValue({ ...state, marketTerms: patch === null ? null : { ...state.marketTerms, ...patch } });
    await expect(prepareOrder(input())).rejects.toThrow("terms");
    expect(mocks.latest).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it.each(["proposer", "approver"] as const)("rejects designated %s wallet", async role => {
    const state = await snapshot(); state.resolution[role].wallet = sender.address; state.marketTerms[role].wallet = sender.address;
    mocks.read.mockResolvedValue(state);
    await expect(prepareOrder(input())).rejects.toThrow("reviewer wallets cannot trade");
    expect(mocks.latest).not.toHaveBeenCalled(); expect(mocks.sign).not.toHaveBeenCalled();
  });
  it.each(["proposer", "approver"] as const)("rejects %s wallet or enrollment differing from frozen resolution", async role => {
    for (const field of ["wallet", "enrollment"] as const) {
      const state = await snapshot(); state.marketTerms[role][field] = seats; mocks.read.mockResolvedValue(state);
      await expect(prepareOrder(input())).rejects.toThrow("reviewers mismatch");
    }
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each(["address", "market", "creator"] as const)("rejects terms %s binding mismatch", async field => {
    const state = await snapshot(); state.marketTerms[field] = sender.address; mocks.read.mockResolvedValue(state);
    await expect(prepareOrder(input())).rejects.toThrow(); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each([0n, -1n, 1_000_000n, 1 as unknown as bigint])("rejects price %s before snapshot", async price => {
    await expect(prepareOrder({ ...input(), price })).rejects.toThrow(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([0n, -1n, 10_000_001n, 1 as unknown as bigint])("rejects quantity %s before snapshot", async quantity => {
    await expect(prepareOrder({ ...input(), quantity })).rejects.toThrow(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects price equal to market payout and insufficient unreserved cash including fees", async () => {
    await expect(prepareOrder({ ...input(), price: 100n })).rejects.toThrow("payout");
    const state = await snapshot(); state.seat.availableCash = 80n; mocks.read.mockResolvedValue(state);
    await expect(prepareOrder(input())).rejects.toThrow("cash"); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("checks outcome-specific free positions, not total holdings or opposite-side positions", async () => {
    expect((await prepareOrder({ ...input(), action: "SELL" })).availablePosition).toBe(2n);
    await expect(prepareOrder({ ...input(), action: "SELL", quantity: 3n })).rejects.toThrow("positions");
    await expect(prepareOrder({ ...input(), action: "SELL", outcome: "NO" })).rejects.toThrow("positions");
    expect((await prepareOrder({ ...input(), action: "SELL", outcome: "NO", quantity: 1n })).requiredCash).toBe(0n);
  });
  it("keeps NO outcome prices and maximal quantity exact", async () => {
    const state = await snapshot(); state.seat.availableCash = 1_000_000_000_000n; mocks.read.mockResolvedValue(state);
    const result = await prepareOrder({ ...input(), outcome: "NO", price: 99n, quantity: 10_000_000n });
    expect(result.requiredCash).toBe(999_900_000n);
    const bytes = new Uint8Array(result.message.instructions[1]!.data!);
    expect(new DataView(bytes.buffer).getBigUint64(16, true)).toBe(99n); expect(bytes[32]).toBe(1);
  });
  it("does not claim client-time expiry or market openness", async () => {
    const result = await prepareOrder({ ...input(), expiresAt: 1n });
    expect(result.clockChecks).toBe("on-chain-only");
    expect(result).not.toHaveProperty("marketOpen"); expect(result).not.toHaveProperty("confirmed");
    await expect(prepareOrder({ ...input(), expiresAt: 1n, timeInForce: "IOC" })).rejects.toThrow("options");
  });
  it("rejects absent seat/book, failed reserve verification, and mismatched snapshot binding", async () => {
    for (const patch of [{ registered: false }, { seat: null }, { orderBook: null }, { wallet: seats }, { finalizedSlot: -1n }, { locator: seats }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch }); await expect(prepareOrder(input())).rejects.toThrow();
    }
    for (const patch of [{ book: seats }, { seats: sender.address }, { feeBps: 0 }, { reservesReconciled: false }]) {
      const state = await snapshot(); mocks.read.mockResolvedValue({ ...state, orderBook: { ...state.orderBook, ...patch } });
      await expect(prepareOrder(input())).rejects.toThrow();
    }
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects exhausted nonce and builder options", async () => {
    const state = await snapshot(); state.seat.nextNonce = (1n << 64n) - 1n; mocks.read.mockResolvedValue(state);
    await expect(prepareOrder(input())).rejects.toThrow("nonce"); mocks.read.mockResolvedValue(await snapshot());
    await expect(prepareOrder({ ...input(), touches: 17 })).rejects.toThrow("options");
  });
  it("re-pins genesis and rejects stale/malformed signing lifetime", async () => {
    mocks.genesis.mockResolvedValue("wrong"); await expect(prepareOrder(input())).rejects.toThrow("genesis");
    expect(mocks.latest).not.toHaveBeenCalled(); mocks.genesis.mockResolvedValue(runtime.genesisHash);
    for (const response of [{ context: { slot: 499n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } },
      { context: { slot: 501n }, value: { blockhash: "invalid", lastValidBlockHeight: 900n } },
      { context: { slot: 501n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } }]) {
      mocks.latest.mockResolvedValue(response); await expect(prepareOrder(input())).rejects.toThrow();
    }
  });
  it("captures inputs before awaits and cannot accept caller nonce/seats overrides", async () => {
    const value = { ...input(), runtime: { ...runtime }, expectedNonce: 0n, seats: sender.address };
    const pending = prepareOrder(value); value.price = 99n; value.runtime.genesisHash = "changed";
    const result = await pending; expect(result.requiredCash).toBe(81n); expect(result.expectedNonce).toBe(9_007_199_254_740_993n);
    expect(result.seats).toBe(seats); expect(result.genesisHash).toBe(runtime.genesisHash);
  });
  it("does not silently refresh nonce after a later preparation observes changed chain state", async () => {
    const first = await prepareOrder(input()), state = await snapshot(); state.seat.nextNonce += 1n;
    mocks.read.mockResolvedValue(state); const second = await prepareOrder(input());
    expect(second.expectedNonce).toBe(first.expectedNonce + 1n); expect(first.expectedNonce).toBe(9_007_199_254_740_993n);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("rejects a wallet switch during the final blockhash request", async () => {
    const mutableSender: { address: Address; signTransactions: typeof sender.signTransactions } = { ...sender };
    const value = { ...input(), sender: mutableSender };
    mocks.latest.mockImplementationOnce(async () => {
      value.sender.address = seats;
      return { context: { slot: 501n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } };
    });
    await expect(prepareOrder(value)).rejects.toThrow("Wallet changed");
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("propagates RPC errors and aborts before or during preparation", async () => {
    const controller = new AbortController(); controller.abort(new Error("Canceled"));
    await expect(prepareOrder({ ...input(), signal: controller.signal })).rejects.toThrow("Canceled"); expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockRejectedValueOnce(new Error("invalid book")); await expect(prepareOrder(input())).rejects.toThrow("invalid book");
    const during = new AbortController(); mocks.latest.mockImplementationOnce(async () => {
      during.abort(new Error("Canceled mid-read")); return { context: { slot: 501n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } };
    });
    await expect(prepareOrder({ ...input(), signal: during.signal })).rejects.toThrow("Canceled mid-read"); expect(mocks.sign).not.toHaveBeenCalled();
  });
});
