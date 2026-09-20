import { address, blockhash, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { prepareOrderReplacement } from "./prepare-replacement";

const mocks = vi.hoisted(() => ({ read: vi.fn(), genesis: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const sender = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"),
  signTransactions: mocks.sign };
const seats = address("SysvarRent111111111111111111111111111111111");

async function snapshot() {
  const p = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId: 7n,
    wallet: sender.address });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, p.market);
  const [resolution] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["resolution", getAddressEncoder().encode(p.market)] });
  const [terms] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["market_terms", getAddressEncoder().encode(p.market)] });
  const reviewers = await Promise.all([address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")].map(async wallet => ({ wallet: wallet as Address,
      enrollment: (await getProgramDerivedAddress({ programAddress: runtime.programAddress,
        seeds: ["enrollment", getAddressEncoder().encode(p.config), getAddressEncoder().encode(wallet)] }))[0] })));
  return { ...p, seats, wallet: sender.address, registered: true, finalizedSlot: 500n,
    resolution: { address: resolution, phase: 0, creator: seats as Address, proposer: reviewers[0]!, approver: reviewers[1]! },
    marketTerms: { address: terms, market: p.market, creator: seats as Address, sealed: true, acceptanceBits: 3,
      proposer: reviewers[0]!, approver: reviewers[1]! },
    marketState: { marketId: 7n, payoutMilli: 100n, feeBps: 100 },
    seat: { index: 0, availableCash: 0n, reservedCash: 81n, yes: 0n, no: 0n,
      reservedYes: 0n, reservedNo: 0n, nextNonce: 9n },
    orderBook: { book, market: p.market, seats, payoutMilli: 100n, feeBps: 100, reservesReconciled: true,
      revision: 12n, nextSequence: 50n, orders: [{ id: 42n, wallet: sender.address, ownerSeat: 0,
        side: "BID" as const, heapIndex: 3, outcome: "YES" as const, action: "BUY" as const,
        limitPrice: 40n, remaining: 2n, chainNotional: 0n, expiresAt: 1_900_000_000n,
        reserve: { cash: 81n, yes: 0n, no: 0n } }] } };
}

beforeEach(async () => {
  vi.resetAllMocks(); mocks.read.mockResolvedValue(await snapshot()); mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue({ context: { slot: 501n },
    value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 900n } });
});

describe("atomic order replacement preparation", () => {
  it("composes compute, exact cancel nonce N, then replacement nonce N+1 from one snapshot", async () => {
    const prepared = await prepareOrderReplacement({ runtime, sender, marketId: 7n, orderId: 42n,
      price: 40n, quantity: 2n, postOnly: true, selfTrade: "CANCEL_AGGRESSOR", touches: 8 });
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({ orderId: 42n, replacementOrderId: 50n, expectedNonce: 9n,
      bookRevision: 12n, expiresAt: 1_900_000_000n, availableCashAfterCancel: 81n, requiredCash: 81n });
    expect(prepared.instructions).toHaveLength(3);
    const cancel = new Uint8Array(prepared.instructions[1].data!), place = new Uint8Array(prepared.instructions[2].data!);
    expect(new DataView(cancel.buffer).getBigUint64(19, true)).toBe(9n);
    expect(new DataView(place.buffer).getBigUint64(8, true)).toBe(10n);
    expect(new DataView(place.buffer).getBigUint64(16, true)).toBe(40n);
    expect(place[36]).toBe(1);
    expect(place.at(-1)).toBe(8);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 500n }]);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("fails before signing lifetime when post-cancel resources cannot back the replacement", async () => {
    await expect(prepareOrderReplacement({ runtime, sender, marketId: 7n, orderId: 42n,
      price: 41n, quantity: 2n, postOnly: false, selfTrade: "CANCEL_AGGRESSOR" }))
      .rejects.toThrow(/after releasing/);
    expect(mocks.latest).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
});
