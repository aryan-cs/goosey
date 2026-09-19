import {
  address, blockhash, getAddressEncoder, getBase64Decoder, getProgramDerivedAddress,
  getSignersFromTransactionMessage, type Address,
} from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { deriveGooseyMarketTermsAddresses } from "./market-terms-client";
import {
  prepareMarketTermsAcceptance, prepareMarketTermsSeal, prepareResolutionProposal, prepareResolutionReview,
} from "./prepare-market-review";
import { deriveGooseyResolutionAddresses, type ResolutionFingerprint } from "./resolution-client";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({ read: vi.fn(), genesis: vi.fn(), latest: vi.fn(), account: vi.fn(),
  creatorSign: vi.fn(), proposerSign: vi.fn(), approverSign: vi.fn() }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: mocks.read }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({
    getGenesisHash: () => ({ send: (options: unknown) => mocks.genesis(options) }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }),
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
  }),
}));

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const creator = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"), signTransactions: mocks.creatorSign };
const proposer = { address: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), signTransactions: mocks.proposerSign };
const approver = { address: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), signTransactions: mocks.approverSign };
const seats = address("SysvarRent111111111111111111111111111111111");
const marketId = 7n;
const digest = (fill: number) => new Uint8Array(32).fill(fill);
const fingerprint = (): ResolutionFingerprint => ({ sequence: 9_007_199_254_740_993n, outcome: "YES",
  reasonDigest: digest(4), evidenceDigest: digest(5) });
const b64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const disc = async (name: string) => new Uint8Array(await crypto.subtle.digest("SHA-256",
  new TextEncoder().encode(`account:${name}`))).slice(0, 8);

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const p = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: proposer.address });
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, p.market);
  const termsAddresses = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId });
  const resolutionAddresses = await deriveGooseyResolutionAddresses({ programAddress: runtime.programAddress, marketId });
  const enc = getAddressEncoder();
  const enrollment = async (wallet: Address) => (await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["enrollment", enc.encode(p.config), enc.encode(wallet)] }))[0];
  const proposerEnrollment = await enrollment(proposer.address), approverEnrollment = await enrollment(approver.address);
  const terms = { address: termsAddresses.terms, version: 1 as const, market: p.market, creator: creator.address,
    digest: digest(3), manifestLength: 1_024, proposer: { wallet: proposer.address, enrollment: proposerEnrollment },
    approver: { wallet: approver.address, enrollment: approverEnrollment }, acceptanceBits: 0, sealed: false,
    bump: termsAddresses.termsBump };
  const resolution = { address: resolutionAddresses.resolution, market: p.market, creator: creator.address,
    proposer: { ...terms.proposer }, approver: { ...terms.approver }, phase: 1, nextProposalSequence: fingerprint().sequence,
    activeProposalSequence: null as bigint | null, outcome: null as number | null };
  const seatRows = [creator.address, proposer.address, approver.address].map((wallet, index) => ({ index, wallet,
    availableCash: 0n, reservedCash: 0n, yes: 0n, no: 0n, reservedYes: 0n, reservedNo: 0n,
    nextNonce: 1n, everTraded: false, expectedReserve: { cash: 0n, yes: 0n, no: 0n } }));
  const base = { ...p, seats, wallet: proposer.address as Address, registered: true, finalizedSlot: 500n,
    marketState: { marketId, creator: creator.address, collateral: 0n, feeRevenue: 0n },
    orderBook: { book, market: p.market, seats, revision: 0n, nextSequence: 1n, orders: [],
      seatReserves: seatRows, reservesReconciled: true as const }, resolution, marketTerms: terms };
  return { p, book, terms, resolution, base };
}

async function termsBytes(f: Fixture, patch: Partial<Pick<Fixture["terms"], "acceptanceBits" | "sealed">> = {}) {
  const terms = { ...f.terms, ...patch }, bytes = new Uint8Array(240), view = new DataView(bytes.buffer), enc = getAddressEncoder();
  bytes.set(await disc("MarketTerms"), 0); bytes[8] = 1; bytes.set(enc.encode(terms.market), 9);
  bytes.set(enc.encode(terms.creator), 41); bytes.set(terms.digest, 73); view.setUint32(105, terms.manifestLength, true);
  bytes.set(enc.encode(terms.proposer.wallet), 109); bytes.set(enc.encode(terms.proposer.enrollment), 141);
  bytes.set(enc.encode(terms.approver.wallet), 173); bytes.set(enc.encode(terms.approver.enrollment), 205);
  bytes[237] = terms.acceptanceBits; bytes[238] = terms.sealed ? 1 : 0; bytes[239] = terms.bump;
  return bytes;
}

async function proposalBytes(f: Fixture, value = fingerprint()) {
  const bytes = new Uint8Array(293), view = new DataView(bytes.buffer), enc = getAddressEncoder();
  bytes.set(await disc("ProposalAccount"), 0); bytes.set(enc.encode(f.p.market), 8);
  view.setBigUint64(40, value.sequence, true); bytes[48] = 1; bytes[49] = value.outcome === "YES" ? 0 : value.outcome === "NO" ? 1 : 2;
  bytes.set(value.reasonDigest, 50); bytes.set(value.evidenceDigest, 82); bytes.set(enc.encode(proposer.address), 114);
  bytes.set(enc.encode(f.terms.proposer.enrollment), 146); view.setBigInt64(178, 1_700_000_000n, true);
  bytes[186] = 1; bytes[187] = 0; bytes[220] = 0;
  return bytes;
}

function rpcAccount(bytes: Uint8Array, slot = 501n) {
  return { context: { slot }, value: { owner: runtime.programAddress, executable: false, data: [b64(bytes), "base64"] } };
}

let f: Fixture;
beforeEach(async () => {
  vi.resetAllMocks(); f = await fixture(); mocks.read.mockResolvedValue(f.base);
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue({ context: { slot: 502n },
    value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 999n } });
  mocks.account.mockImplementation(async () => rpcAccount(await termsBytes(f)));
});
afterEach(() => {
  expect(mocks.creatorSign).not.toHaveBeenCalled(); expect(mocks.proposerSign).not.toHaveBeenCalled();
  expect(mocks.approverSign).not.toHaveBeenCalled();
});

describe("market terms wallet preparation", () => {
  it("prepares designated proposer acceptance from a finalized pristine market/terms view", async () => {
    const result = await prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(3) });
    const contract: PreparedWalletTransaction = result;
    expect(contract.message).toBe(result.message);
    expect(result).toMatchObject({ operation: "ACCEPT_TERMS", role: "proposer", expectedAcceptanceBits: 0,
      expectedSealed: false, financialObservedSlot: 500n, observedSlot: 501n, blockhashSlot: 502n, bookRevision: 0n });
    expect(result.expectedDigestSha256).toEqual(digest(3));
    expect(getSignersFromTransactionMessage(result.message)).toEqual([proposer]);
    expect(result.message.feePayer.address).toBe(proposer.address); expect(result.message.instructions).toHaveLength(1);
    expect(mocks.read).toHaveBeenCalledWith({ ...runtime, rpcUrl: `${runtime.rpcUrl}/` }, { marketId, wallet: proposer.address },
      expect.objectContaining({ includeOrderBook: true, signal: expect.any(AbortSignal) }));
    expect(mocks.account.mock.calls[0]![0]![1]).toEqual(expect.objectContaining({ commitment: "finalized", minContextSlot: 500n }));
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 501n }]);
  });

  it("prepares creator sealing only after both bits and exposes the pre-sign state", async () => {
    const creatorSnapshot = { ...f.base, wallet: creator.address }; mocks.read.mockResolvedValue(creatorSnapshot);
    mocks.account.mockImplementation(async () => rpcAccount(await termsBytes(f, { acceptanceBits: 3 })));
    const result = await prepareMarketTermsSeal({ runtime, creator, marketId, expectedDigestSha256: digest(3) });
    expect(result).toMatchObject({ operation: "SEAL_TERMS", expectedAcceptanceBits: 3, expectedSealed: false,
      financialObservedSlot: 500n, observedSlot: 501n, bookRevision: 0n });
    expect(getSignersFromTransactionMessage(result.message)).toEqual([creator]);
    expect(result.message.feePayer.address).toBe(creator.address);
  });

  it("rejects wrong role, duplicate acceptance, digest mismatch, and premature/already sealing", async () => {
    const outsider = { ...creator, address: seats };
    mocks.read.mockResolvedValue({ ...f.base, wallet: outsider.address });
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: outsider, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("designated");
    mocks.read.mockResolvedValue(f.base); mocks.account.mockImplementation(async () => rpcAccount(await termsBytes(f, { acceptanceBits: 1 })));
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("already accepted");
    mocks.account.mockImplementation(async () => rpcAccount(await termsBytes(f)));
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(9) })).rejects.toThrow("digest changed");
    mocks.read.mockResolvedValue({ ...f.base, wallet: creator.address });
    await expect(prepareMarketTermsSeal({ runtime, creator, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("both acceptances");
    mocks.account.mockImplementation(async () => rpcAccount(await termsBytes(f, { acceptanceBits: 3, sealed: true })));
    await expect(prepareMarketTermsSeal({ runtime, creator, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("unsealed");
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("fails closed when the finalized market is non-pristine or the terms read is stale/malformed", async () => {
    for (const orderBook of [{ ...f.base.orderBook, revision: 1n }, { ...f.base.orderBook, nextSequence: 2n },
      { ...f.base.orderBook, orders: [{}] }, { ...f.base.orderBook, seatReserves: [{ ...f.base.orderBook.seatReserves[1]!, everTraded: true }] }]) {
      mocks.read.mockResolvedValue({ ...f.base, orderBook });
      await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("pristine");
    }
    mocks.read.mockResolvedValue(f.base); mocks.account.mockResolvedValue({ ...rpcAccount(await termsBytes(f)), context: { slot: 499n } });
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("terms snapshot");
    mocks.account.mockResolvedValue({ context: { slot: 501n }, value: null });
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId, expectedDigestSha256: digest(3) })).rejects.toThrow("terms snapshot");
  });
});

describe("resolution reviewer wallet preparation", () => {
  beforeEach(async () => {
    f.base.marketTerms = { ...f.terms, acceptanceBits: 3, sealed: true };
    mocks.read.mockResolvedValue(f.base);
  });

  it("prepares the designated proposer's exact next fingerprint without signing", async () => {
    const value = fingerprint();
    const result = await prepareResolutionProposal({ runtime, proposer, marketId, expectedNextSequence: value.sequence,
      outcome: value.outcome, reasonDigestSha256: value.reasonDigest, evidenceDigestSha256: value.evidenceDigest });
    expect(result).toMatchObject({ operation: "PROPOSE_RESOLUTION", expectedPhase: 1,
      expectedNextSequence: value.sequence, expectedActiveProposalSequence: null, expectedTermsAcceptanceBits: 3,
      expectedTermsSealed: true, designatedProposer: proposer.address, designatedApprover: approver.address,
      observedSlot: 500n, blockhashSlot: 502n });
    expect(result.fingerprint).toEqual(value); expect(getSignersFromTransactionMessage(result.message)).toEqual([proposer]);
    expect(result.message.feePayer.address).toBe(proposer.address); expect(result.message.instructions).toHaveLength(1);
    expect(mocks.account).not.toHaveBeenCalled();
  });

  it.each(["APPROVE", "REJECT"] as const)("prepares independent exact-fingerprint %s", async decision => {
    const value = fingerprint(); f.base.wallet = approver.address;
    f.base.resolution = { ...f.resolution, phase: 2, activeProposalSequence: value.sequence,
      nextProposalSequence: value.sequence + 1n };
    mocks.read.mockResolvedValue(f.base); mocks.account.mockImplementation(async () => rpcAccount(await proposalBytes(f), 503n));
    mocks.latest.mockResolvedValue({ context: { slot: 504n },
      value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 999n } });
    const result = await prepareResolutionReview({ runtime, approver, marketId, expected: value,
      decision: decision === "APPROVE" ? { decision } : { decision, reviewDigestSha256: digest(8) } });
    expect(result).toMatchObject({ operation: `${decision}_RESOLUTION`, expectedPhase: 2,
      expectedActiveProposalSequence: value.sequence, expectedNextSequence: value.sequence + 1n,
      expectedTermsAcceptanceBits: 3, expectedTermsSealed: true,
      designatedProposer: proposer.address, designatedApprover: approver.address,
      observedSlot: 500n, proposalObservedSlot: 503n, blockhashSlot: 504n });
    expect(result.reviewDigestSha256).toEqual(decision === "REJECT" ? digest(8) : null);
    expect(getSignersFromTransactionMessage(result.message)).toEqual([approver]);
    expect(result.message.feePayer.address).toBe(approver.address);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 503n }]);
  });

  it("rejects wrong proposer role, wrong phase, stale next sequence, invalid outcomes and digests", async () => {
    const value = fingerprint();
    mocks.read.mockResolvedValue({ ...f.base, wallet: approver.address });
    await expect(prepareResolutionProposal({ runtime, proposer: approver, marketId, expectedNextSequence: value.sequence,
      outcome: value.outcome, reasonDigestSha256: value.reasonDigest, evidenceDigestSha256: value.evidenceDigest })).rejects.toThrow("designated proposer");
    mocks.read.mockResolvedValue({ ...f.base, resolution: { ...f.resolution, phase: 0 } });
    await expect(prepareResolutionProposal({ runtime, proposer, marketId, expectedNextSequence: value.sequence,
      outcome: value.outcome, reasonDigestSha256: value.reasonDigest, evidenceDigestSha256: value.evidenceDigest })).rejects.toThrow("phase");
    mocks.read.mockResolvedValue(f.base);
    await expect(prepareResolutionProposal({ runtime, proposer, marketId, expectedNextSequence: value.sequence + 1n,
      outcome: value.outcome, reasonDigestSha256: value.reasonDigest, evidenceDigestSha256: value.evidenceDigest })).rejects.toThrow("stale");
    await expect(prepareResolutionProposal({ runtime, proposer, marketId, expectedNextSequence: value.sequence,
      outcome: "MAYBE" as "YES", reasonDigestSha256: value.reasonDigest, evidenceDigestSha256: value.evidenceDigest })).rejects.toThrow("outcome");
    await expect(prepareResolutionProposal({ runtime, proposer, marketId, expectedNextSequence: value.sequence,
      outcome: value.outcome, reasonDigestSha256: new Uint8Array(32), evidenceDigestSha256: value.evidenceDigest })).rejects.toThrow("Reason digest");
    await expect(prepareResolutionReview({ runtime, approver, marketId, expected: value,
      decision: { decision: "MAYBE" } as never })).rejects.toThrow("review decision");
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("rejects stale review phase/sequence, wrong approver and changed proposal fingerprint", async () => {
    const value = fingerprint(); f.base.wallet = approver.address;
    const pending = { ...f.resolution, phase: 2, activeProposalSequence: value.sequence,
      nextProposalSequence: value.sequence + 1n };
    f.base.resolution = pending; mocks.read.mockResolvedValue(f.base);
    mocks.account.mockImplementation(async () => rpcAccount(await proposalBytes(f, { ...value, outcome: "NO" })));
    await expect(prepareResolutionReview({ runtime, approver, marketId, expected: value,
      decision: { decision: "APPROVE" } })).rejects.toThrow("fingerprint");
    mocks.read.mockResolvedValue({ ...f.base, resolution: { ...pending, activeProposalSequence: value.sequence - 1n } });
    await expect(prepareResolutionReview({ runtime, approver, marketId, expected: value,
      decision: { decision: "APPROVE" } })).rejects.toThrow("stale");
    mocks.read.mockResolvedValue({ ...f.base, wallet: proposer.address });
    await expect(prepareResolutionReview({ runtime, approver: proposer, marketId, expected: value,
      decision: { decision: "APPROVE" } })).rejects.toThrow("independent");
  });

  it("rejects malformed/non-pending proposal envelopes before obtaining a blockhash", async () => {
    const value = fingerprint(); f.base.wallet = approver.address;
    f.base.resolution = { ...f.resolution, phase: 2, activeProposalSequence: value.sequence,
      nextProposalSequence: value.sequence + 1n }; mocks.read.mockResolvedValue(f.base);
    for (const mutate of [
      (bytes: Uint8Array) => { bytes[0] ^= 1; },
      (bytes: Uint8Array) => { bytes[186] = 2; },
      (bytes: Uint8Array) => { bytes[187] = 1; },
      (bytes: Uint8Array) => { bytes[188] = 1; },
    ]) {
      const bytes = await proposalBytes(f); mutate(bytes); mocks.account.mockResolvedValue(rpcAccount(bytes));
      await expect(prepareResolutionReview({ runtime, approver, marketId, expected: value,
        decision: { decision: "APPROVE" } })).rejects.toThrow();
    }
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});

describe("shared preparation safety contract", () => {
  it("re-pins genesis and rejects a stale or malformed signing lifetime", async () => {
    mocks.genesis.mockResolvedValue("wrong");
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId,
      expectedDigestSha256: digest(3) })).rejects.toThrow("genesis changed");
    mocks.genesis.mockResolvedValue(runtime.genesisHash);
    for (const response of [
      { context: { slot: 500n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 9n } },
      { context: { slot: 502n }, value: { blockhash: "bad", lastValidBlockHeight: 9n } },
      { context: { slot: 502n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } },
    ]) {
      mocks.latest.mockResolvedValue(response);
      await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId,
        expectedDigestSha256: digest(3) })).rejects.toThrow();
    }
  });

  it("captures caller inputs, rejects wallet mutation, and propagates aborts without signing", async () => {
    const expectedDigestSha256 = digest(3), value = { runtime: { ...runtime }, reviewer: proposer,
      marketId, expectedDigestSha256 };
    const pending = prepareMarketTermsAcceptance(value); expectedDigestSha256.fill(9); value.runtime.genesisHash = "changed";
    expect((await pending).expectedDigestSha256).toEqual(digest(3));
    const mutable: { address: Address; signTransactions: typeof proposer.signTransactions } = { ...proposer };
    mocks.latest.mockImplementationOnce(async () => {
      mutable.address = seats; return { context: { slot: 502n },
        value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 9n } };
    });
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: mutable, marketId,
      expectedDigestSha256: digest(3) })).rejects.toThrow("wallet changed");
    const controller = new AbortController(); controller.abort(new Error("Canceled"));
    await expect(prepareMarketTermsAcceptance({ runtime, reviewer: proposer, marketId,
      expectedDigestSha256: digest(3), signal: controller.signal })).rejects.toThrow("Canceled");
  });
});
