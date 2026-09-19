import { createHash } from "node:crypto";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { deriveGooseyMarketAddresses } from "./escrow-client";
import { readResolutionState } from "./resolution-state";

const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const creator = address("SysvarRent111111111111111111111111111111111");
const reviewers = [address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")];
// Binary ABI fixtures only; no synthetic accounts are sent to a chain.
async function fixture(phase = 0, active: bigint | null = null, outcome: number | null = null) {
  const addresses = await deriveGooseyMarketAddresses({ programAddress: program, marketId: 7n });
  const binding = { market: addresses.market, config: addresses.config, creator, payoutMilli: 1000n, closesAt: 100n, resolvesAt: 110n };
  const [pda] = await getProgramDerivedAddress({ programAddress: program, seeds: ["resolution", getAddressEncoder().encode(binding.market)] });
  const bytes = Buffer.alloc(268, 0xa5); bytes.set(createHash("sha256").update("account:ResolutionState").digest().subarray(0, 8));
  let offset = 8;
  const key = (value: Address) => { bytes.set(getAddressEncoder().encode(value), offset); offset += 32; };
  const integer = (value: bigint) => { bytes.writeBigUInt64LE(value, offset); offset += 8; };
  key(binding.market); key(creator); integer(1000n); integer(100n); integer(110n);
  for (const wallet of reviewers) {
    key(wallet);
    const [enrollment] = await getProgramDerivedAddress({ programAddress: program,
      seeds: ["enrollment", getAddressEncoder().encode(binding.config), getAddressEncoder().encode(wallet)] });
    key(enrollment);
  }
  bytes[offset++] = phase; integer(phase === 0 ? 1n : 2n);
  const activeOffset = offset;
  bytes[offset++] = active === null ? 0 : 1; if (active !== null) integer(active);
  const outcomeOffset = offset;
  bytes[offset++] = outcome === null ? 0 : 1; if (outcome !== null) bytes[offset++] = outcome;
  const holdingsOffset = offset;
  integer(phase > 0 && phase < 4 ? 9n : 0n); integer(phase > 0 && phase < 4 ? 9n : 0n); integer(0n);
  const account = { address: pda, owner: program, executable: false, data: bytes };
  return { bytes, binding, account, activeOffset, outcomeOffset, holdingsOffset,
    read: () => readResolutionState(program, binding, account) };
}

describe("resolution state ABI", () => {
  it.each([[0, null, null], [1, null, null], [2, 1n, null], [3, null, 0], [3, null, 1], [3, null, 2], [4, null, 2]] as const)(
    "decodes phase %s including variable Options and retained nonzero tail", async (phase, active, outcome) => {
      const f = await fixture(phase, active, outcome);
      expect(await f.read()).toMatchObject({ phase, activeProposalSequence: active, outcome, nextProposalSequence: phase === 0 ? 1n : 2n, claimsProcessed: 0n });
    });
  it("accepts unequal outstanding holdings during actual payout phase without rounding counters", async () => {
    const f = await fixture(3, null, 1);
    f.bytes.writeBigUInt64LE(9007199254740993n, f.holdingsOffset);
    f.bytes.writeBigUInt64LE(3n, f.holdingsOffset + 16);
    expect(await f.read()).toMatchObject({ outstandingYes: 9007199254740993n, outstandingNo: 9n, claimsProcessed: 3n });
  });
  it.each([[0, 1n, null], [1, null, 0], [2, null, null], [2, 2n, null], [3, null, null], [3, 1n, 1], [4, null, 3], [5, null, null]] as const)(
    "rejects inconsistent phase/options %s %s %s", async (phase, active, outcome) => {
      const f = await fixture(phase, active, outcome); await expect(f.read()).rejects.toThrow();
    });
  it("rejects malformed Option tags rather than shifting following fields", async () => {
    for (const field of ["activeOffset", "outcomeOffset"] as const) {
      const f = await fixture(); f.bytes[f[field]] = 2; await expect(f.read()).rejects.toThrow("option");
    }
  });
  it("rejects mismatched market, discriminator, owner, length and PDA", async () => {
    const f = await fixture();
    for (const patch of [{ owner: creator }, { address: creator }, { executable: true }, { data: f.bytes.subarray(1) }]) {
      await expect(readResolutionState(program, f.binding, { ...f.account, ...patch })).rejects.toThrow();
    }
    f.bytes[0] ^= 1; await expect(f.read()).rejects.toThrow("discriminator"); f.bytes[0] ^= 1;
    await expect(readResolutionState(program, { ...f.binding, payoutMilli: 999n }, f.account)).rejects.toThrow("binding");
  });
  it("rejects substituted reviewer enrollment and creator/reviewer conflict", async () => {
    const f = await fixture(); f.bytes[128] ^= 1; await expect(f.read()).rejects.toThrow("enrollment");
    const other = await fixture(); other.bytes.set(getAddressEncoder().encode(creator), 96);
    await expect(other.read()).rejects.toThrow("reviewers");
  });
  it("rejects claims before resolution, unbalanced closed holdings and outstanding finalized positions", async () => {
    for (const phase of [0, 1, 4]) {
      const f = await fixture(phase, null, phase === 4 ? 0 : null);
      f.bytes.writeBigUInt64LE(1n, f.holdingsOffset + (phase === 0 ? 16 : 0));
      await expect(f.read()).rejects.toThrow("lifecycle");
    }
  });
});
