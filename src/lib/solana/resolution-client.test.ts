import { createHash } from "node:crypto";
import { address, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, getSignersFromInstruction, type Address } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { buildInitializeResolutionInstruction, buildCloseResolutionInstruction, buildFinalizeResolutionInstruction,
  buildProposeResolutionInstruction, buildApproveResolutionInstruction, buildRejectResolutionInstruction,
  buildClaimResolutionInstruction, deriveGooseyResolutionAddresses, type ResolutionOutcome } from "./resolution-client";

// Offline codec fixtures only: no wallet signing, RPC or chain execution proof.
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const creator = createNoopSigner(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
const reviewer = createNoopSigner(address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
const approver = address("SysvarC1ock11111111111111111111111111111111");
const base = { programAddress, marketId: 9007199254740993n, seats: address("SysvarRent111111111111111111111111111111111") };
const expected = () => ({ sequence: 9007199254740995n, outcome: "YES" as ResolutionOutcome,
  reasonDigest: Uint8Array.from({ length: 32 }, (_, i) => i + 1), evidenceDigest: new Uint8Array(32).fill(79) });
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const bytes = (n: bigint, width = 8) => { const b = Buffer.alloc(width); if (width === 8) b.writeBigUInt64LE(n); else b.writeUInt32LE(Number(n)); return b; };
const fingerprint = (f: ReturnType<typeof expected>) => Buffer.concat([bytes(f.sequence), Buffer.from([f.outcome === "YES" ? 0 : f.outcome === "NO" ? 1 : 2]), f.reasonDigest, f.evidenceDigest]);
const key = (value: Address) => getAddressEncoder().encode(value);
async function derive(seed: string, market: Address, suffix?: Uint8Array) {
  return (await getProgramDerivedAddress({ programAddress, seeds: [seed, key(market), ...(suffix ? [suffix] : [])] }))[0];
}

describe("resolution Anchor builders (offline ABI fixtures)", () => {
  it("derives terms after System without accepting caller terms overrides", async () => {
    const args = { ...base, creator, proposer: reviewer.address, approver, terms: base.seats };
    const a = await buildInitializeResolutionInstruction(args);
    expect(a.instruction.accounts).toHaveLength(10);
    expect(a.instruction.accounts[8]).toEqual({ address: SYSTEM_PROGRAM_ADDRESS, role: 0 });
    expect(a.instruction.accounts[9]).toEqual({ address: await derive("market_terms", a.market), role: 0 });
    expect(a.terms).not.toBe(base.seats);
  });
  it("derives canonical resolution/book and separates markets", async () => {
    const a = await deriveGooseyResolutionAddresses(base);
    expect(a.resolution).toBe(await derive("resolution", a.market));
    expect(a.book).toBe(await derive("order_book", a.market));
    expect((await deriveGooseyResolutionAddresses({ ...base, marketId: base.marketId + 1n })).resolution).not.toBe(a.resolution);
  });
  it("initializes with canonical enrollments and exact ordered permissions", async () => {
    const a = await buildInitializeResolutionInstruction({ ...base, creator, proposer: reviewer.address, approver });
    for (const [wallet, enrollment] of [[reviewer.address, a.proposerEnrollment], [approver, a.approverEnrollment]]) {
      expect(enrollment).toBe((await getProgramDerivedAddress({ programAddress, seeds: ["enrollment", key(a.config), key(wallet)] }))[0]);
    }
    expect(a.instruction.accounts.map(m => m.address)).toEqual([creator.address, a.config, a.market, base.seats, a.book, a.proposerEnrollment, a.approverEnrollment, a.resolution, SYSTEM_PROGRAM_ADDRESS, a.terms]);
    expect(a.terms).toBe(await derive("market_terms", a.market));
    expect(a.instruction.accounts.map(m => m.role)).toEqual([3, 0, 1, 0, 1, 0, 0, 1, 0, 0]);
    expect(Buffer.from(a.instruction.data)).toEqual(disc("initialize_resolution"));
    expect(getSignersFromInstruction(a.instruction)).toEqual([creator]);
  });
  it.each(["close", "finalize"] as const)("%s has read-only keeper/seats/vault and no args", async kind => {
    const a = await (kind === "close" ? buildCloseResolutionInstruction : buildFinalizeResolutionInstruction)({ ...base, keeper: reviewer });
    expect(a.instruction.accounts.map(m => m.address)).toEqual([reviewer.address, a.market, base.seats, a.book, a.resolution, a.vault]);
    expect(a.instruction.accounts.map(m => m.role)).toEqual([2, 1, 0, 1, 1, 0]);
    expect(Buffer.from(a.instruction.data)).toEqual(disc(`${kind}_resolution`));
    expect(getSignersFromInstruction(a.instruction)).toEqual([reviewer]);
  });
  it.each(["YES", "NO", "VOID"] as const)("encodes exact %s proposal layout and enrollment", async outcome => {
    const f = { ...expected(), outcome };
    const a = await buildProposeResolutionInstruction({ ...base, reviewer, ...f });
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc("propose_resolution"), fingerprint(f)]));
    expect(a.proposal).toBe(await derive("resolution_proposal", a.market, bytes(f.sequence)));
    expect(a.reviewerEnrollment).toBe((await getProgramDerivedAddress({ programAddress, seeds: ["enrollment", key(a.config), key(reviewer.address)] }))[0]);
    expect(a.instruction.accounts.map(m => m.address)).toEqual([reviewer.address, a.config, a.market, base.seats, a.reviewerEnrollment, reviewer.address, a.resolution, a.proposal, SYSTEM_PROGRAM_ADDRESS]);
    expect(a.instruction.accounts.map(m => m.role)).toEqual([3, 0, 1, 0, 0, 0, 1, 1, 0]);
    expect(getSignersFromInstruction(a.instruction)).toEqual([reviewer]);
  });
  it.each(["approve", "reject"] as const)("%s binds duplicate sequence, outcome, reason and evidence", async kind => {
    const f = expected(), reviewDigest = new Uint8Array(32).fill(92);
    const a = await (kind === "approve" ? buildApproveResolutionInstruction : buildRejectResolutionInstruction)({ ...base, reviewer, expected: f, reviewDigest });
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc(`${kind}_resolution`), bytes(f.sequence), fingerprint(f), ...(kind === "reject" ? [reviewDigest] : [])]));
    expect(a.proposal).toBe(await derive("resolution_proposal", a.market, bytes(f.sequence)));
    expect(a.instruction.accounts.map(m => m.address)).toEqual([reviewer.address, a.config, a.market, base.seats, a.reviewerEnrollment, reviewer.address, a.resolution, a.proposal]);
    expect(a.instruction.accounts.map(m => m.role)).toEqual([2, 0, 1, 0, 0, 0, 1, 1]);
    expect(getSignersFromInstruction(a.instruction)).toEqual([reviewer]);
  });
  it.each([0, 255])("claims seat %i using u32 seed and no user-controlled payout/nonce", async seatIndex => {
    const a = await buildClaimResolutionInstruction({ ...base, payer: creator, seatIndex });
    expect(a.receipt).toBe(await derive("resolution_claim", a.market, bytes(BigInt(seatIndex), 4)));
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc("claim_resolution"), bytes(BigInt(seatIndex), 4)]));
    expect(a.instruction.accounts.map(m => m.address)).toEqual([creator.address, a.market, base.seats, a.book, a.resolution, a.receipt, a.vault, SYSTEM_PROGRAM_ADDRESS]);
    expect(a.instruction.accounts.map(m => m.role)).toEqual([3, 1, 1, 1, 1, 1, 0, 0]);
    expect(getSignersFromInstruction(a.instruction)).toEqual([creator]);
  });
  it("captures mutable digests and inputs before awaits", async () => {
    const f = expected(), original = fingerprint(f), input = { ...base, reviewer, expected: f, reviewDigest: new Uint8Array(32).fill(3) };
    const pending = buildRejectResolutionInstruction(input);
    f.sequence = 4n; f.outcome = "VOID"; f.reasonDigest.fill(0); f.evidenceDigest.fill(0); input.reviewDigest.fill(0); input.marketId = 1n;
    const a = await pending;
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc("reject_resolution"), bytes(9007199254740995n), original, new Uint8Array(32).fill(3)]));
    expect(a.market).toBe((await deriveGooseyResolutionAddresses(base)).market);
  });
  it.each([new Uint8Array(20).fill(1), new Uint8Array(31).fill(1), new Uint8Array(33).fill(1), new Uint8Array(32)])("rejects invalid digest %j", bad => {
    expect(() => buildProposeResolutionInstruction({ ...base, reviewer, ...expected(), reasonDigest: bad })).toThrow(/Digest/);
    expect(() => buildApproveResolutionInstruction({ ...base, reviewer, expected: { ...expected(), evidenceDigest: bad } })).toThrow(/Digest/);
    expect(() => buildRejectResolutionInstruction({ ...base, reviewer, expected: expected(), reviewDigest: bad })).toThrow(/Digest/);
  });
  it.each([0n, -1n, 1n << 64n, 2 as unknown as bigint])("rejects sequence %s", sequence => {
    expect(() => buildApproveResolutionInstruction({ ...base, reviewer, expected: { ...expected(), sequence } })).toThrow(/sequence/);
  });
  it("rejects sequence overflow and invalid outcome without coercion", () => {
    expect(() => buildProposeResolutionInstruction({ ...base, reviewer, ...expected(), sequence: (1n << 64n) - 1n })).toThrow(/advance/);
    expect(() => buildProposeResolutionInstruction({ ...base, reviewer, ...expected(), outcome: "toString" as ResolutionOutcome })).toThrow(/outcome/);
  });
  it.each([-1, 256, 1.5, NaN])("rejects invalid seat %s", async seatIndex => {
    await expect(buildClaimResolutionInstruction({ ...base, payer: creator, seatIndex })).rejects.toThrow(/seat/);
  });
  it.each([SYSTEM_PROGRAM_ADDRESS, creator.address, reviewer.address])("rejects invalid approver %s", async invalid => {
    await expect(buildInitializeResolutionInstruction({ ...base, creator, proposer: reviewer.address, approver: invalid })).rejects.toThrow(/Reviewers/);
  });
  it("rejects zero signer", async () => {
    await expect(buildCloseResolutionInstruction({ ...base, keeper: createNoopSigner(SYSTEM_PROGRAM_ADDRESS) })).rejects.toThrow(/nonzero/);
  });
});
