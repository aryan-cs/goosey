import { address, blockhash, getAddressEncoder, getProgramDerivedAddress, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { buildDepositInstruction, buildWithdrawInstruction, deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { prepareEscrowDeposit, prepareEscrowWithdrawal } from "./prepare-escrow";
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
const nonce = 9_007_199_254_740_995n, MAX = (1n << 64n) - 1n;
const input = () => ({ runtime: { ...runtime }, sender, marketId: 7n, amount: 100n });
const lifetime = () => ({ context: { slot: 501n }, value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 900n } });
async function snapshot() {
  const a = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n, wallet: sender.address });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, a.market);
  const [resolution] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["resolution", getAddressEncoder().encode(a.market)] });
  return { ...a, seats, wallet: sender.address, registered: true, finalizedSlot: 500n,
    marketState: { seats, marketId: 7n, accountedVault: 600n }, vaultAmount: 700n, walletTokenAmount: 300n,
    seat: { availableCash: 200n, reservedCash: 400n, nextNonce: nonce }, resolution: { address: resolution, phase: 0 },
    orderBook: { book, market: a.market, seats, reservesReconciled: true } };
}
beforeEach(async () => { vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot());
  mocks.genesis.mockResolvedValue(runtime.genesisHash); mocks.latest.mockResolvedValue(lifetime()); });
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

describe("escrow preparation: mocked finalized reader/RPC, shipping builders (not chain proof)", () => {
  it.each(["deposit", "withdrawal"] as const)("%s has exact shipping instruction, chain nonce, sole owner/payer", async direction => {
    const result = await (direction === "deposit" ? prepareEscrowDeposit : prepareEscrowWithdrawal)(input());
    const contract: PreparedWalletTransaction = result; expect(contract.message).toBe(result.message);
    const plan = await (direction === "deposit" ? buildDepositInstruction : buildWithdrawInstruction)({
      programAddress: runtime.programAddress, marketId: 7n, wallet: sender, seats, amount: 100n, expectedNonce: nonce });
    expect(result.message.instructions).toEqual([plan.instruction]);
    expect(result.message.feePayer.address).toBe(sender.address);
    expect(getSignersFromTransactionMessage(result.message)).toEqual([sender]);
    expect(result.message.lifetimeConstraint).toEqual(lifetime().value);
    expect(result).toMatchObject({ direction, amount: 100n, expectedNonce: nonce, availableCash: 200n, reservedCash: 400n,
      walletTokenAmount: 300n, observedSlot: 500n, blockhashSlot: 501n, genesisHash: runtime.genesisHash });
    expect(mocks.read).toHaveBeenCalledWith(runtime, { marketId: 7n, wallet: sender.address }, expect.objectContaining({ includeResolution: true }));
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 500n }]);
    expect(result).not.toHaveProperty("confirmed");
  });
  it("separates wallet SPL from unreserved cash; permits exact balances", async () => {
    await prepareEscrowDeposit({ ...input(), amount: 300n });
    await expect(prepareEscrowDeposit({ ...input(), amount: 301n })).rejects.toThrow("wallet SPL");
    await prepareEscrowWithdrawal({ ...input(), amount: 200n });
    await expect(prepareEscrowWithdrawal({ ...input(), amount: 201n })).rejects.toThrow("unreserved");
  });
  it.each([1, 2, 3, 4])("does not wrongly prohibit transfers in verified phase %i", async phase => {
    const state = await snapshot(); state.resolution.phase = phase; mocks.read.mockResolvedValue(state);
    await prepareEscrowWithdrawal(input()); await prepareEscrowDeposit(input());
  });
  it.each([0n, -1n, 1n << 64n, 1 as unknown as bigint])("rejects invalid amount %s before RPC", async amount => {
    await expect(prepareEscrowDeposit({ ...input(), amount })).rejects.toThrow("amount");
    await expect(prepareEscrowWithdrawal({ ...input(), amount })).rejects.toThrow("amount"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects invalid market ID before reading", async () => {
    await expect(prepareEscrowDeposit({ ...input(), marketId: -1n })).rejects.toThrow("market ID"); expect(mocks.read).not.toHaveBeenCalled();
  });
  it("requires existing wallet ATA for both directions but accepts zero recipient balance", async () => {
    mocks.read.mockResolvedValue({ ...await snapshot(), walletTokenAmount: null });
    await expect(prepareEscrowDeposit(input())).rejects.toThrow("already exist");
    await expect(prepareEscrowWithdrawal(input())).rejects.toThrow("already exist");
    mocks.read.mockResolvedValue({ ...await snapshot(), walletTokenAmount: 0n }); await prepareEscrowWithdrawal(input());
  });
  it("fails closed on absent accounts and mismatched canonical bindings", async () => {
    for (const patch of [{ registered: false }, { seat: null }, { resolution: null }, { orderBook: null }, { wallet: seats },
      { market: seats }, { config: seats }, { vault: seats }, { locator: seats }, { featherMint: seats }, { walletTokens: seats },
      { enrollment: seats }, { finalizedSlot: -1n }, { finalizedSlot: 500 }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch }); await expect(prepareEscrowDeposit(input())).rejects.toThrow();
    }
    for (const patch of [{ book: seats }, { market: seats }, { seats: sender.address }, { reservesReconciled: false }]) {
      const state = await snapshot(); mocks.read.mockResolvedValue({ ...state, orderBook: { ...state.orderBook, ...patch } });
      await expect(prepareEscrowWithdrawal(input())).rejects.toThrow();
    }
    for (const patch of [{ resolution: { address: seats, phase: 0 } }, { marketState: { seats: sender.address, marketId: 7n, accountedVault: 600n } }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch }); await expect(prepareEscrowDeposit(input())).rejects.toThrow();
    }
    expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it("propagates phase-aware backing failures without weaker fallback", async () => {
    mocks.read.mockRejectedValue(new Error("Resolved outcome collateral mismatch"));
    await expect(prepareEscrowWithdrawal(input())).rejects.toThrow("collateral mismatch");
    expect(mocks.read).toHaveBeenCalledTimes(1); expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it("checks u64 arithmetic and exhausted nonce", async () => {
    for (const patch of [{ seat: { availableCash: MAX, reservedCash: 0n, nextNonce: nonce } },
      { marketState: { seats, marketId: 7n, accountedVault: MAX } }, { vaultAmount: MAX }]) {
      mocks.read.mockResolvedValue({ ...await snapshot(), ...patch }); await expect(prepareEscrowDeposit(input())).rejects.toThrow("overflow");
    }
    mocks.read.mockResolvedValue({ ...await snapshot(), walletTokenAmount: MAX });
    await expect(prepareEscrowWithdrawal(input())).rejects.toThrow("overflow");
    const state = await snapshot(); state.seat.nextNonce = MAX; mocks.read.mockResolvedValue(state);
    await expect(prepareEscrowDeposit(input())).rejects.toThrow(/Nonce/);
  });
  it("captures runtime/amount/market before awaits and ignores caller nonce/seats extras", async () => {
    const value = { ...input(), expectedNonce: 0n, seats: sender.address };
    const pending = prepareEscrowDeposit(value); value.amount = 1n; value.marketId = 3n; value.runtime.genesisHash = "wrong";
    const result = await pending; expect(result.amount).toBe(100n); expect(result.expectedNonce).toBe(nonce);
    expect(result.seats).toBe(seats); expect(result.genesisHash).toBe(runtime.genesisHash);
  });
  it("does not change a prepared nonce after a race or silently reprepare", async () => {
    const first = await prepareEscrowWithdrawal(input()), state = await snapshot(); state.seat.nextNonce++; state.seat.availableCash = 101n;
    mocks.read.mockResolvedValue(state); const second = await prepareEscrowWithdrawal(input());
    expect(first.expectedNonce).toBe(nonce); expect(first.availableCash).toBe(200n);
    expect(second.expectedNonce).toBe(nonce + 1n); expect(mocks.read).toHaveBeenCalledTimes(2);
  });
  it("rejects changed genesis and propagates RPC failures without retries", async () => {
    mocks.genesis.mockResolvedValue("other"); await expect(prepareEscrowDeposit(input())).rejects.toThrow("genesis changed");
    expect(mocks.latest).not.toHaveBeenCalled(); mocks.genesis.mockResolvedValue(runtime.genesisHash);
    mocks.latest.mockRejectedValue(new Error("RPC unavailable")); await expect(prepareEscrowWithdrawal(input())).rejects.toThrow("RPC unavailable");
    expect(mocks.latest).toHaveBeenCalledTimes(1);
  });
  it("rejects stale or malformed lifetime", async () => {
    for (const response of [{ ...lifetime(), context: { slot: 499n } }, { ...lifetime(), context: { slot: 501 } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } },
      { ...lifetime(), value: { blockhash: "bad", lastValidBlockHeight: 900n } }]) {
      mocks.latest.mockResolvedValue(response); await expect(prepareEscrowDeposit(input())).rejects.toThrow();
    }
  });
  it("rejects wallet switching during lifetime request", async () => {
    const mutable: { address: Address; signTransactions: typeof mocks.sign } = { ...sender };
    mocks.latest.mockImplementation(async () => { mutable.address = seats; return lifetime(); });
    await expect(prepareEscrowWithdrawal({ ...input(), sender: mutable })).rejects.toThrow("Wallet changed");
  });
  it("honors pre-abort and post-await abort and forwards cancellation", async () => {
    const before = new AbortController(); before.abort(new Error("stop"));
    await expect(prepareEscrowDeposit({ ...input(), signal: before.signal })).rejects.toThrow("stop"); expect(mocks.read).not.toHaveBeenCalled();
    const during = new AbortController(); mocks.latest.mockImplementation(async () => { during.abort(new Error("stop later")); return lifetime(); });
    await expect(prepareEscrowWithdrawal({ ...input(), signal: during.signal })).rejects.toThrow("stop later");
    expect(mocks.read.mock.calls[0]![2].signal).toBe(during.signal);
    expect(mocks.genesis.mock.calls[0]![0].abortSignal).toBe(during.signal);
    expect(mocks.latest.mock.calls[0]![1].abortSignal).toBe(during.signal);
  });
});
