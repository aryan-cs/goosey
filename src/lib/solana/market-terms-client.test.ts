import { createHash } from "node:crypto";
import { AccountRole, address, createNoopSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildInitializeMarketTermsInstruction, buildAcceptMarketTermsInstruction, buildSealMarketTermsInstruction,
  deriveGooseyMarketTermsAddresses, readMarketTermsAccount, MARKET_TERMS_ACCOUNT_BYTES } from "./market-terms-client";
import { MARKET_TERMS_MAX_BYTES } from "./market-terms";

// Offline ABI fixtures; noop signer objects are never invoked or sent to RPC.
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const creator = createNoopSigner(wallet(1)), proposer = wallet(2), approver = wallet(3), seats = wallet(4);
const hash = () => new Uint8Array(32).fill(0x5a);
const input = () => ({ programAddress, marketId: 7n, seats, creator, proposer, approver, version: 1 as const, digest: hash(), manifestLength: 1234 });
const disc = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const enc = getAddressEncoder(), ro = AccountRole.READONLY, rw = AccountRole.WRITABLE;
async function fixture() {
  const a = await deriveGooseyMarketTermsAddresses(input());
  const enrollment = async (who: typeof proposer) => (await getProgramDerivedAddress({ programAddress, seeds: ["enrollment", enc.encode(a.config), enc.encode(who)] }))[0];
  const binding = { programAddress, marketId: 7n, config: a.config, market: a.market, creator: creator.address,
    proposer: { wallet: proposer, enrollment: await enrollment(proposer) }, approver: { wallet: approver, enrollment: await enrollment(approver) } };
  const bytes = Buffer.alloc(MARKET_TERMS_ACCOUNT_BYTES);
  bytes.set(disc("account:MarketTerms")); bytes[8] = 1;
  for (const [offset, value] of [[9, a.market], [41, creator.address], [109, proposer], [141, binding.proposer.enrollment],
    [173, approver], [205, binding.approver.enrollment]] as const) bytes.set(enc.encode(value), offset);
  bytes.set(hash(), 73); bytes.writeUInt32LE(1234, 105); bytes[237] = 3; bytes[238] = 1; bytes[239] = a.termsBump;
  const account = { address: a.terms, owner: programAddress as Address, executable: false, data: bytes };
  return { a, binding, bytes, account, read: () => readMarketTermsAccount(binding, account) };
}
describe("market terms unsigned proposed ABI", () => {
  it("derives canonical config/market/book/terms PDAs independently", async () => {
    const a = await deriveGooseyMarketTermsAddresses(input()), id = Buffer.alloc(8); id.writeBigUInt64LE(7n);
    const pda = async (seeds: Parameters<typeof getProgramDerivedAddress>[0]["seeds"]) => getProgramDerivedAddress({ programAddress, seeds });
    expect(a.config).toBe((await pda(["config"]))[0]);
    expect(a.market).toBe((await pda(["market", enc.encode(a.config), id]))[0]);
    expect(a.book).toBe((await pda(["order_book", enc.encode(a.market)]))[0]);
    expect([a.terms, a.termsBump]).toEqual(await pda(["market_terms", enc.encode(a.market)]));
  });
  it("freezes initialize account order/roles and exact discriminator + Borsh payload", async () => {
    const a = await buildInitializeMarketTermsInstruction(input()), size = Buffer.alloc(4); size.writeUInt32LE(1234);
    expect(Buffer.from(a.instruction.data!)).toEqual(Buffer.concat([disc("global:initialize_market_terms"), Buffer.from([1]), hash(), size]));
    expect(a.instruction.accounts.map(a => [a.address, a.role])).toEqual([
      [creator.address, AccountRole.WRITABLE_SIGNER], [a.config, ro], [a.market, ro], [seats, ro], [a.book, ro],
      [a.proposerEnrollment, ro], [a.approverEnrollment, ro], [a.terms, rw], ["11111111111111111111111111111111", ro],
    ]);
    expect(a.instruction.data.length).toBe(45);
  });
  it("freezes accept account order/roles and exact digest payload", async () => {
    const reviewer = createNoopSigner(proposer);
    const a = await buildAcceptMarketTermsInstruction({ ...input(), reviewer, expectedDigest: hash() });
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc("global:accept_market_terms"), hash()]));
    expect(a.instruction.accounts.map(a => [a.address, a.role])).toEqual([
      [proposer, AccountRole.READONLY_SIGNER], [a.config, ro], [a.market, ro], [seats, ro], [a.reviewerEnrollment, ro], [a.terms, rw],
    ]);
  });
  it("freezes seal account order/roles and exact digest payload", async () => {
    const a = await buildSealMarketTermsInstruction({ ...input(), expectedDigest: hash() });
    expect(Buffer.from(a.instruction.data)).toEqual(Buffer.concat([disc("global:seal_market_terms"), hash()]));
    expect(a.instruction.accounts.map(a => [a.address, a.role])).toEqual([
      [creator.address, AccountRole.READONLY_SIGNER], [a.config, ro], [a.market, ro], [seats, ro], [a.book, ro], [a.terms, rw],
    ]);
  });
  it("captures mutable arguments and digest before first await", async () => {
    const original = input(), pending = buildInitializeMarketTermsInstruction(original);
    original.digest.fill(0); original.marketId = 8n; original.manifestLength = 2; original.proposer = wallet(9); original.seats = wallet(10);
    expect(await pending).toEqual(await buildInitializeMarketTermsInstruction(input()));
    const acceptance = { ...input(), reviewer: createNoopSigner(proposer), expectedDigest: hash() };
    const accepting = buildAcceptMarketTermsInstruction(acceptance); acceptance.expectedDigest.fill(0); acceptance.marketId = 8n;
    expect(Buffer.from((await accepting).instruction.data).subarray(8)).toEqual(Buffer.from(hash()));
    const sealing = { ...input(), expectedDigest: hash() }, sealed = buildSealMarketTermsInstruction(sealing); sealing.expectedDigest.fill(0);
    expect(Buffer.from((await sealed).instruction.data).subarray(8)).toEqual(Buffer.from(hash()));
  });
  it("refuses a signer whose address changes during asynchronous construction", async () => {
    const mutableSigner = { ...creator, address: wallet(1) };
    const pending = buildSealMarketTermsInstruction({ ...input(), creator: mutableSigner, expectedDigest: hash() });
    mutableSigner.address = wallet(9);
    await expect(pending).rejects.toThrow("Signer identity changed");
  });
  it.each([0, -1, 1.5, NaN, MARKET_TERMS_MAX_BYTES + 1])("rejects manifest length %s", manifestLength =>
    expect(buildInitializeMarketTermsInstruction({ ...input(), manifestLength })).rejects.toThrow());
  it.each([new Uint8Array(32), new Uint8Array(31).fill(1), new Uint8Array(33).fill(1)])("rejects invalid digest %#", async digest => {
    await expect(buildInitializeMarketTermsInstruction({ ...input(), digest })).rejects.toThrow();
    await expect(buildAcceptMarketTermsInstruction({ ...input(), reviewer: creator, expectedDigest: digest })).rejects.toThrow();
    await expect(buildSealMarketTermsInstruction({ ...input(), expectedDigest: digest })).rejects.toThrow();
  });
  it.each([-1n, 1n << 64n])("rejects out-of-range market ID %s", marketId => expect(deriveGooseyMarketTermsAddresses({ programAddress, marketId })).rejects.toThrow());
  it("rejects conflicting reviewers, invalid version and non-signers", async () => {
    await expect(buildInitializeMarketTermsInstruction({ ...input(), approver: proposer })).rejects.toThrow();
    await expect(buildInitializeMarketTermsInstruction({ ...input(), proposer: creator.address })).rejects.toThrow();
    await expect(buildInitializeMarketTermsInstruction({ ...input(), version: 2 as 1 })).rejects.toThrow();
    await expect(buildSealMarketTermsInstruction({ ...input(), expectedDigest: hash(), creator: { address: creator.address } as typeof creator })).rejects.toThrow();
  });
});
describe("strict pure 240-byte MarketTerms decoder", () => {
  it("decodes fixed offsets without claiming slot, finality, or content verification", async () => {
    const f = await fixture(), v = await f.read();
    expect(v).toEqual({ address: f.a.terms, version: 1, market: f.a.market, creator: creator.address, digest: hash(), manifestLength: 1234,
      proposer: f.binding.proposer, approver: f.binding.approver, acceptanceBits: 3, sealed: true, bump: f.a.termsBump });
    expect(v).not.toHaveProperty("finalizedSlot"); expect(v).not.toHaveProperty("verified");
  });
  it.each([[0, 0], [1, 0], [2, 0], [3, 0], [3, 1]])("accepts static bit/boolean combination %s/%s", async (bits, sealed) => {
    const f = await fixture(); f.bytes[237] = bits; f.bytes[238] = sealed;
    expect((await f.read()).sealed).toBe(sealed === 1);
  });
  it.each([[0, 1], [1, 1], [2, 1], [4, 0], [255, 0], [3, 2], [3, 255]])("rejects invalid bit/boolean combination %s/%s", async (bits, sealed) => {
    const f = await fixture(); f.bytes[237] = bits; f.bytes[238] = sealed; await expect(f.read()).rejects.toThrow();
  });
  it.each([0, 8, 9, 41, 73, 109, 141, 173, 205, 239])("rejects discriminator/version/binding/bump corruption at %s", async offset => {
    const f = await fixture(); if (offset === 73) f.bytes.fill(0, 73, 105); else f.bytes[offset] ^= 1;
    await expect(f.read()).rejects.toThrow();
  });
  it.each([0, MARKET_TERMS_MAX_BYTES + 1, 0xffffffff])("rejects manifest length field %s", async value => {
    const f = await fixture(); f.bytes.writeUInt32LE(value, 105); await expect(f.read()).rejects.toThrow();
  });
  it("rejects wrong owner/address/executable and all extra padding", async () => {
    const f = await fixture();
    for (const changed of [{ owner: wallet(8) }, { address: wallet(8) }, { executable: true },
      { data: f.bytes.subarray(0, 239) }, { data: Buffer.concat([f.bytes, Buffer.from([0])]) }]) {
      await expect(readMarketTermsAccount(f.binding, { ...f.account, ...changed })).rejects.toThrow();
    }
  });
  it("rejects mutually matching but noncanonical reviewer enrollment", async () => {
    const f = await fixture(); f.binding.proposer.enrollment = wallet(8); f.bytes.set(enc.encode(wallet(8)), 141);
    await expect(f.read()).rejects.toThrow("Noncanonical terms reviewer enrollment");
  });
  it("rejects trusted-binding market ID/config mismatch", async () => {
    const f = await fixture(); f.binding.marketId = 8n; await expect(f.read()).rejects.toThrow("PDA");
    f.binding.marketId = 7n; f.binding.config = wallet(9); await expect(f.read()).rejects.toThrow("PDA");
  });
  it("snapshots account bytes and nested expected identities before await", async () => {
    const f = await fixture(), pending = f.read(); f.bytes.fill(0); f.binding.proposer.wallet = wallet(9); f.account.owner = wallet(9);
    expect((await pending).proposer.wallet).toBe(proposer);
  });
});
