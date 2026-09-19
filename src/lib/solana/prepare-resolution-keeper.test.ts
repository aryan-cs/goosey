import { AccountRole, address, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyMarketTermsAddresses } from "./market-terms-client";
import { prepareResolutionClose, prepareResolutionFinalize } from "./prepare-resolution-keeper";
import { deriveGooseyResolutionAddresses } from "./resolution-client";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({
  read: vi.fn(), blockTime: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn(),
}));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({
  ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({
    getBlockTime: (...args: unknown[]) => ({ send: (options: unknown) => mocks.blockTime(args, options) }),
    getGenesisHash: () => ({ send: (options: unknown) => mocks.genesis(options) }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }),
  }),
}));

const runtime = {
  cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
};
const keeper = {
  address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W") as Address,
  signTransactions: mocks.sign,
};
const creator: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const proposer: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const approver: Address = address("SysvarRent111111111111111111111111111111111");
const seats: Address = address("Vote111111111111111111111111111111111111111");
const marketId = 7n;
const lifetime = () => ({ context: { slot: 503n }, value: {
  blockhash: runtime.genesisHash, lastValidBlockHeight: 900n,
} });

async function snapshot(phase = 0, outcome: number | null = null) {
  const base = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress,
    marketId, wallet: keeper.address });
  const resolutionAddresses = await deriveGooseyResolutionAddresses({
    programAddress: runtime.programAddress, marketId,
  });
  const termsAddresses = await deriveGooseyMarketTermsAddresses({
    programAddress: runtime.programAddress, marketId,
  });
  const reviewer = (wallet: Address, enrollment: Address) => ({ wallet, enrollment });
  const open = phase === 0;
  const rows = [keeper.address, creator].map((wallet, index) => ({
    index, wallet, availableCash: 100n, reservedCash: 0n,
    yes: open && index === 0 ? 3n : 0n, no: open && index === 0 ? 3n : 0n,
    reservedYes: 0n, reservedNo: 0n, nextNonce: 1n, everTraded: false,
    expectedReserve: { cash: 0n, yes: 0n, no: 0n },
  }));
  const proposerBinding = reviewer(proposer, base.locator);
  const approverBinding = reviewer(approver, base.walletTokens);
  return {
    ...base, seats, wallet: keeper.address, registered: false, seat: null,
    finalizedSlot: 500n, vaultAmount: open ? 3_200n : 200n, vaultSurplus: 0n,
    marketState: { marketId, creator, seats, payoutMilli: 1000n, closesAt: 100n,
      resolvesAt: 200n, accountedVault: open ? 3_200n : 200n,
      collateral: open ? 3_000n : 0n, feeRevenue: 0n, feeBps: 25 },
    orderBook: { book: resolutionAddresses.book, market: base.market, seats, revision: 19n,
      nextSequence: 4n, payoutMilli: 1000n, feeBps: 25, bids: [], asks: [], orders: [],
      seatReserves: rows, reservesReconciled: true as const },
    resolution: { address: resolutionAddresses.resolution, market: base.market, creator,
      proposer: proposerBinding, approver: approverBinding, phase, nextProposalSequence: phase === 0 ? 1n : 2n,
      activeProposalSequence: null, outcome, outstandingYes: 0n, outstandingNo: 0n,
      claimsProcessed: phase === 3 ? 2n : 0n },
    marketTerms: { address: termsAddresses.terms, market: base.market, creator,
      proposer: proposerBinding, approver: approverBinding, acceptanceBits: 3, sealed: true },
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(await snapshot());
  mocks.blockTime.mockResolvedValue(100n);
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue(lifetime());
});
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

function expectUnsignedSoleKeeper(result: PreparedWalletTransaction) {
  expect(result.sender).toBe(keeper.address);
  expect(result.message.feePayer.address).toBe(keeper.address);
  expect(getSignersFromTransactionMessage(result.message).map(value => value.address)).toEqual([keeper.address]);
}

describe("permissionless resolution keeper wallet preparation", () => {
  it("prepares exact Open -> Closed instruction using finalized chain time", async () => {
    const result = await prepareResolutionClose({ runtime, keeper, marketId });
    expectUnsignedSoleKeeper(result);
    expect(result).toMatchObject({ operation: "CLOSE_RESOLUTION", keeper: keeper.address,
      expectedPhase: 0, expectedNextPhase: 1, expectedBookRevision: 19n,
      observedSlot: 500n, blockhashSlot: 503n, closesAt: 100n, observedChainTime: 100n,
      lifetime: lifetime().value });
    expect(mocks.read).toHaveBeenCalledWith(runtime, { marketId, wallet: keeper.address },
      expect.objectContaining({ includeOrderBook: true, includeResolution: true, includeMarketTerms: true }));
    expect(mocks.blockTime.mock.calls[0]![0]).toEqual([500n]);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 500n }]);
    const instruction = result.message.instructions[0]!;
    expect(result.message.instructions).toHaveLength(1);
    expect(instruction.accounts!.map(account => account.address)).toEqual([
      keeper.address, result.market, seats, result.book, result.resolution, result.vault,
    ]);
    expect(instruction.accounts![0]!.role).toBe(AccountRole.READONLY_SIGNER);
    const discriminator = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode("global:close_resolution"))).slice(0, 8);
    expect(new Uint8Array(instruction.data!)).toEqual(discriminator);
  });

  it("prepares exact Resolved -> Finalized instruction from drained verified liabilities", async () => {
    mocks.read.mockResolvedValue(await snapshot(3, 2));
    const result = await prepareResolutionFinalize({ runtime, keeper, marketId });
    expectUnsignedSoleKeeper(result);
    expect(result).toMatchObject({ operation: "FINALIZE_RESOLUTION", expectedPhase: 3,
      expectedNextPhase: 4, expectedBookRevision: 19n, observedSlot: 500n,
      blockhashSlot: 503n, observedChainTime: null, lifetime: lifetime().value });
    expect(mocks.blockTime).not.toHaveBeenCalled();
    const instruction = result.message.instructions[0]!;
    expect(instruction.accounts!.map(account => account.address)).toEqual([
      keeper.address, result.market, seats, result.book, result.resolution, result.vault,
    ]);
    const discriminator = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode("global:finalize_resolution"))).slice(0, 8);
    expect(new Uint8Array(instruction.data!)).toEqual(discriminator);
  });

  it("rejects an early close from finalized chain time and every wrong close phase", async () => {
    mocks.blockTime.mockResolvedValue(99n);
    await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("before");
    expect(mocks.genesis).not.toHaveBeenCalled();
    for (const phase of [1, 2, 3, 4]) {
      mocks.read.mockResolvedValue(await snapshot(phase, phase >= 3 ? 0 : null));
      await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("Open phase");
    }
  });

  it("rejects malformed chain time instead of consulting local wall-clock time", async () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("wall clock used"); });
    for (const value of [null, 100, 1n << 63n, -(1n << 63n) - 1n]) {
      mocks.blockTime.mockResolvedValue(value);
      await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("on-chain close time");
    }
    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("rejects wrong finalize phases, remaining claims, orders, reserves and non-VOID liability", async () => {
    for (const phase of [0, 1, 2, 4]) {
      mocks.read.mockResolvedValue(await snapshot(phase, phase === 4 ? 0 : null));
      await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("Resolved phase");
    }
    const liabilities = await snapshot(3, 0); liabilities.resolution.outstandingYes = 1n;
    mocks.read.mockResolvedValue(liabilities);
    await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("claims");
    const positions = await snapshot(3, 0); positions.orderBook.seatReserves[0]!.yes = 1n;
    mocks.read.mockResolvedValue(positions);
    await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("claims");
    const orders = await snapshot(3, 0); orders.orderBook.orders.push({} as never);
    mocks.read.mockResolvedValue(orders);
    await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("orders");
    const reserves = await snapshot(3, 0); reserves.orderBook.seatReserves[0]!.reservedCash = 1n;
    mocks.read.mockResolvedValue(reserves);
    await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("reserves");
    const collateral = await snapshot(3, 0); collateral.marketState.collateral = 1n;
    mocks.read.mockResolvedValue(collateral);
    await expect(prepareResolutionFinalize({ runtime, keeper, marketId })).rejects.toThrow("collateral");
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("rejects unsealed terms and mismatched current market/book/resolution/terms bindings", async () => {
    const unsealed = await snapshot(); unsealed.marketTerms.sealed = false;
    mocks.read.mockResolvedValue(unsealed);
    await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("sealed");
    for (const mutate of [
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.wallet = creator; },
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.finalizedSlot = -1n; },
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.orderBook.market = creator; },
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.resolution.market = creator; },
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.marketTerms.creator = keeper.address; },
      (value: Awaited<ReturnType<typeof snapshot>>) => { value.marketTerms.proposer.wallet = creator; },
    ]) {
      const value = await snapshot(); mutate(value); mocks.read.mockResolvedValue(value);
      await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow();
    }
  });

  it("re-pins genesis and rejects signer mutation before returning a message", async () => {
    mocks.genesis.mockResolvedValue("wrong");
    await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("genesis changed");
    mocks.genesis.mockResolvedValue(runtime.genesisHash);
    for (const boundary of [mocks.read, mocks.blockTime, mocks.genesis, mocks.latest]) {
      const mutable = { ...keeper };
      const state = await snapshot();
      boundary.mockImplementationOnce(async () => {
        mutable.address = creator;
        if (boundary === mocks.read) return state;
        if (boundary === mocks.blockTime) return 100n;
        if (boundary === mocks.genesis) return runtime.genesisHash;
        return lifetime();
      });
      await expect(prepareResolutionClose({ runtime, keeper: mutable, marketId })).rejects.toThrow("Keeper wallet changed");
    }
  });

  it("rejects stale or malformed finalized signing lifetimes", async () => {
    for (const response of [
      { ...lifetime(), context: { slot: 499n } },
      { ...lifetime(), context: { slot: 503 } },
      { ...lifetime(), context: { slot: 1n << 64n } },
      { ...lifetime(), value: { blockhash: "bad", lastValidBlockHeight: 900n } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 1n << 64n } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900 } },
    ]) {
      mocks.latest.mockResolvedValue(response);
      await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow();
    }
  });

  it("copies inputs, validates runtime/market before RPC, and never signs", async () => {
    const value = { runtime: { ...runtime }, keeper: { ...keeper }, marketId };
    const pending = prepareResolutionClose(value);
    value.marketId = 8n; value.runtime.genesisHash = "changed"; value.keeper = { ...keeper, address: creator };
    expect(await pending).toMatchObject({ market: (await snapshot()).market, sender: keeper.address,
      genesisHash: runtime.genesisHash });
    for (const id of [-1n, 1n << 64n, 1 as unknown as bigint]) {
      await expect(prepareResolutionClose({ runtime, keeper, marketId: id })).rejects.toThrow("market ID");
    }
    await expect(prepareResolutionClose({ runtime: { ...runtime, cluster: "mainnet" as "localnet" },
      keeper, marketId })).rejects.toThrow("mainnet");
  });

  it("propagates abort before and during RPC while threading the same signal", async () => {
    const before = new AbortController(); before.abort(new Error("Canceled"));
    await expect(prepareResolutionClose({ runtime, keeper, marketId, signal: before.signal }))
      .rejects.toThrow("Canceled");
    expect(mocks.read).not.toHaveBeenCalled();
    const during = new AbortController();
    mocks.latest.mockImplementationOnce(async () => {
      during.abort(new Error("Canceled in flight")); return lifetime();
    });
    await expect(prepareResolutionClose({ runtime, keeper, marketId, signal: during.signal }))
      .rejects.toThrow("Canceled in flight");
    expect(mocks.read.mock.calls[0]![2].signal).toBe(during.signal);
    expect(mocks.blockTime.mock.calls[0]![1].abortSignal).toBe(during.signal);
    expect(mocks.genesis.mock.calls[0]![0].abortSignal).toBe(during.signal);
    expect(mocks.latest.mock.calls[0]![1].abortSignal).toBe(during.signal);
  });

  it("propagates RPC failures without retrying or producing a signed transaction", async () => {
    for (const boundary of [mocks.read, mocks.blockTime, mocks.genesis, mocks.latest]) {
      boundary.mockRejectedValueOnce(new Error("RPC unavailable"));
      await expect(prepareResolutionClose({ runtime, keeper, marketId })).rejects.toThrow("RPC unavailable");
    }
  });
});
