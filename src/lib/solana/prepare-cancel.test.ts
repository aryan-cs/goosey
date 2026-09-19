import { address, blockhash, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { prepareCancelOrder } from "./prepare-cancel";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const sender = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"), signTransactions: mocks.sign };
const seats = address("SysvarRent111111111111111111111111111111111");
const orderId = 9_007_199_254_740_993n;
const input = () => ({ runtime: { ...runtime }, sender, marketId: 7n, orderId });
const lifetime = () => ({ context: { slot: 501n }, value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 900n } });
async function snapshot() {
  const p = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n, wallet: sender.address });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, p.market);
  return { ...p, seats, wallet: sender.address, registered: true, finalizedSlot: 500n,
    marketState: { closesAt: 1n }, seat: { index: 4, nextNonce: orderId + 7n },
    orderBook: { book, market: p.market, seats, reservesReconciled: true, revision: 32n,
      orders: [{ id: orderId, wallet: sender.address as Address, ownerSeat: 4, side: "ASK" as "ASK" | "BID", heapIndex: 513,
        remaining: 3n, expiresAt: 1n, reserve: { cash: 0n, yes: 3n, no: 0n } }] } };
}
beforeEach(async () => {
  vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot()); mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue(lifetime());
});
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

describe("cancel preparation: mocked finalized snapshot/RPC, real builder, no chain proof", () => {
  it("captures exact owner target, u16 heap hint and large nonce from the same snapshot", async () => {
    const result = await prepareCancelOrder(input());
    const contract: PreparedWalletTransaction = result;
    expect(contract.message).toBe(result.message);
    expect(mocks.read).toHaveBeenCalledWith(runtime, { marketId: 7n, wallet: sender.address }, expect.objectContaining({ includeOrderBook: true, signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ orderId, expectedNonce: orderId + 7n, target: { orderId, side: "ASK", heapIndex: 513 },
      observedSlot: 500n, bookRevision: 32n, observedReserve: { cash: 0n, yes: 3n, no: 0n }, cluster: "localnet", genesisHash: runtime.genesisHash });
    expect(result.message.feePayer.address).toBe(sender.address);
    expect(getSignersFromTransactionMessage(result.message)).toEqual([sender]);
    expect(result.message.instructions).toHaveLength(1);
    const ix = result.message.instructions[0]!;
    expect(ix.programAddress).toBe(runtime.programAddress); expect(ix.accounts![3]!.address).toBe(seats);
    const bytes = new Uint8Array(ix.data!), view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(27); expect(view.getBigUint64(8, true)).toBe(orderId);
    expect(bytes[16]).toBe(1); expect(view.getUint16(17, true)).toBe(513); expect(view.getBigUint64(19, true)).toBe(orderId + 7n);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 500n }]);
    expect(result.message.lifetimeConstraint).toEqual(lifetime().value);
  });
  it("supports BID boundary hint and does not reject closed markets or expired positive orders", async () => {
    const state = await snapshot(); state.orderBook.orders[0]!.side = "BID"; state.orderBook.orders[0]!.heapIndex = 1023;
    mocks.read.mockResolvedValue(state); const result = await prepareCancelOrder(input());
    expect(result.target).toEqual({ orderId, side: "BID", heapIndex: 1023 });
    expect(new Uint8Array(result.message.instructions[0]!.data!)[16]).toBe(0);
    expect(result).not.toHaveProperty("confirmed");
  });
  it.each([0n, -1n, 1n << 64n, 1 as unknown as bigint])("rejects invalid order ID %s before reads", async id => {
    await expect(prepareCancelOrder({ ...input(), orderId: id })).rejects.toThrow("order ID"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects an order owned by another wallet or another seat independently", async () => {
    for (const patch of [{ wallet: seats }, { ownerSeat: 5 }]) {
      const state = await snapshot(); Object.assign(state.orderBook.orders[0]!, patch); mocks.read.mockResolvedValue(state);
      await expect(prepareCancelOrder(input())).rejects.toThrow("owner");
    }
    expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it("does not retarget missing orders to a different live ID at the same heap position", async () => {
    const state = await snapshot(); state.orderBook.orders[0]!.id += 1n; mocks.read.mockResolvedValue(state);
    await expect(prepareCancelOrder(input())).rejects.toThrow("no longer resting");
    expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects missing/unverified seat/book and mismatched canonical bindings", async () => {
    for (const patch of [{ registered: false }, { seat: null }, { orderBook: null }, { wallet: seats },
      { market: seats }, { config: seats }, { locator: seats }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch }); await expect(prepareCancelOrder(input())).rejects.toThrow();
    }
    for (const patch of [{ reservesReconciled: false }, { book: seats }]) {
      const state = await snapshot(); mocks.read.mockResolvedValue({ ...state, orderBook: { ...state.orderBook, ...patch } });
      await expect(prepareCancelOrder(input())).rejects.toThrow();
    }
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each([-1, 1024, 1.5])("rejects invalid observed heap hint %s without refreshing or guessing", async heapIndex => {
    const state = await snapshot(); state.orderBook.orders[0]!.heapIndex = heapIndex; mocks.read.mockResolvedValue(state);
    await expect(prepareCancelOrder(input())).rejects.toThrow("target"); expect(mocks.read).toHaveBeenCalledTimes(1);
  });
  it("rejects exhausted on-chain nonce", async () => {
    const state = await snapshot(); state.seat.nextNonce = (1n << 64n) - 1n; mocks.read.mockResolvedValue(state);
    await expect(prepareCancelOrder(input())).rejects.toThrow("nonce");
  });
  it("captures input ID/network and ignores extra caller nonce/target overrides", async () => {
    const value = { ...input(), expectedNonce: 0n, target: { orderId: 1n, side: "BID", heapIndex: 0 }, seats: sender.address };
    const pending = prepareCancelOrder(value); value.orderId += 1n; value.runtime.genesisHash = "wrong";
    const result = await pending;
    expect(result.target).toEqual({ orderId, side: "ASK", heapIndex: 513 }); expect(result.expectedNonce).toBe(orderId + 7n);
    expect(result.genesisHash).toBe(runtime.genesisHash);
  });
  it("re-pins network before lifetime and does not retry RPC failures", async () => {
    mocks.genesis.mockResolvedValue("wrong"); await expect(prepareCancelOrder(input())).rejects.toThrow("genesis changed");
    expect(mocks.latest).not.toHaveBeenCalled();
    mocks.genesis.mockRejectedValue(new Error("network down")); await expect(prepareCancelOrder(input())).rejects.toThrow("network down");
    mocks.genesis.mockResolvedValue(runtime.genesisHash); mocks.latest.mockRejectedValue(new Error("blockhash unavailable"));
    await expect(prepareCancelOrder(input())).rejects.toThrow("blockhash unavailable"); expect(mocks.latest).toHaveBeenCalledTimes(1);
  });
  it("rejects stale/malformed finalized blockhash lifetime", async () => {
    for (const response of [{ ...lifetime(), context: { slot: 499n } }, { ...lifetime(), context: { slot: 501 } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } },
      { ...lifetime(), value: { blockhash: "bad", lastValidBlockHeight: 900n } }]) {
      mocks.latest.mockResolvedValue(response); await expect(prepareCancelOrder(input())).rejects.toThrow();
    }
  });
  it("keeps the prepared hint/nonce fixed while a new explicit attempt reads changed state", async () => {
    const first = await prepareCancelOrder(input());
    const state = await snapshot(); state.seat.nextNonce += 1n; state.orderBook.orders[0]!.heapIndex = 0;
    state.orderBook.orders[0]!.reserve.yes = 1n; state.orderBook.revision += 1n; mocks.read.mockResolvedValue(state);
    const second = await prepareCancelOrder(input());
    expect(second.target.heapIndex).toBe(0); expect(second.expectedNonce).toBe(first.expectedNonce + 1n);
    expect(first.target.heapIndex).toBe(513); expect(first.observedReserve.yes).toBe(3n);
    expect(second.observedReserve.yes).toBe(1n); expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("rejects wallet switch while final blockhash is pending", async () => {
    const mutableSender: { address: Address; signTransactions: typeof sender.signTransactions } = { ...sender };
    mocks.latest.mockImplementationOnce(async () => { mutableSender.address = seats; return lifetime(); });
    await expect(prepareCancelOrder({ ...input(), sender: mutableSender })).rejects.toThrow("Wallet changed");
  });
  it("aborts before reading and never returns a prepared message after an in-flight abort", async () => {
    const before = new AbortController(); before.abort(new Error("Canceled"));
    await expect(prepareCancelOrder({ ...input(), signal: before.signal })).rejects.toThrow("Canceled"); expect(mocks.read).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.latest.mockImplementationOnce(async () => { during.abort(new Error("Canceled during request")); return lifetime(); });
    await expect(prepareCancelOrder({ ...input(), signal: during.signal })).rejects.toThrow("Canceled during request");
    expect(mocks.read.mock.calls[0]![2].signal).toBe(during.signal);
    expect(mocks.genesis.mock.calls[0]![0].abortSignal).toBe(during.signal);
    expect(mocks.latest.mock.calls[0]![1].abortSignal).toBe(during.signal);
  });
  it("fails closed on snapshot errors", async () => {
    mocks.read.mockRejectedValue(new Error("book reserves mismatch"));
    await expect(prepareCancelOrder(input())).rejects.toThrow("book reserves mismatch"); expect(mocks.genesis).not.toHaveBeenCalled();
  });
});
