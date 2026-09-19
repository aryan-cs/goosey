import { address, createNoopSigner, getAddressEncoder, getProgramDerivedAddress, getSignersFromInstruction, type AccountMeta, type TransactionSigner } from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, parseCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { buildAuthorizeEnrollmentInstruction, buildClaimFeathersInstructions, buildInitializeInstruction,
  deriveGooseyEnrollmentAddresses, deriveGooseyProgramAddresses } from "./program-client";

// Pure builder fixtures: no RPC, wallet signing, balances or chain execution claims.
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = createNoopSigner(TOKEN_PROGRAM_ADDRESS);
const payer = createNoopSigner(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
const digest = () => new Uint8Array(32).fill(7);
const maxU64 = (1n << 64n) - 1n;
const initialize = () => ({ programAddress, admin: payer, environment: 1 as const, genesisDomain: digest(),
  enrollmentAuthority: wallet.address, perWalletCap: 9_007_199_254_740_993n, campaignCap: maxU64 });
const authorize = () => ({ programAddress, enrollmentAuthority: payer, wallet: wallet.address,
  identityDigest: digest(), allowance: maxU64, expiresAt: (1n << 63n) - 1n });
const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("Goosey program foundation builders", () => {
  it("derives canonical fixed vectors including loader program data and non-255 bumps", async () => {
    const addresses = await deriveGooseyEnrollmentAddresses({ programAddress, wallet: wallet.address, identityDigest: digest() });
    expect(addresses).toEqual({
      config: "EyzAKgT9Zw9JZ3CjTWCfYooR9avWR7jaWqXW38pUnEdj", configBump: 255,
      mintAuthority: "7aPa8JcDK91nw6HNWjdwP8w3gucJDo39gcuNRaHFH2xG", mintAuthorityBump: 253,
      featherMint: "EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw", featherMintBump: 252,
      programData: "6NZ1Sv6Q1owwykKVZBG7QuCxwzojoH8XEAXAbns4Hnu", programDataBump: 254,
      enrollment: "EKNbyr5Ar3RG72Bx3kK4krLtWodVzXZo6cbT5XT3JSRk", enrollmentBump: 252,
      identity: "HpaXT1uTsXcgwyq1iguV5qjsynFk4kS7gpVHQTPjct6g", identityBump: 253,
    });
    expect(await deriveGooseyEnrollmentAddresses({ programAddress, wallet: wallet.address, identityDigest: digest() })).toEqual(addresses);
    const otherProgram = await deriveGooseyProgramAddresses(payer.address);
    expect(otherProgram.config).not.toBe(addresses.config);
    expect(otherProgram.programData).not.toBe(addresses.programData);
  });

  it("binds enrollment to wallet and identity to digest independently under config", async () => {
    const original = await deriveGooseyEnrollmentAddresses({ programAddress, wallet: wallet.address, identityDigest: digest() });
    const newWallet = await deriveGooseyEnrollmentAddresses({ programAddress, wallet: payer.address, identityDigest: digest() });
    const newIdentity = await deriveGooseyEnrollmentAddresses({ programAddress, wallet: wallet.address, identityDigest: new Uint8Array(32).fill(8) });
    expect(newWallet.enrollment).not.toBe(original.enrollment);
    expect(newWallet.identity).toBe(original.identity);
    expect(newIdentity.enrollment).toBe(original.enrollment);
    expect(newIdentity.identity).not.toBe(original.identity);
  });

  it("encodes initialize exact discriminator/Borsh bytes and ordered signer metas", async () => {
    const plan = await buildInitializeInstruction(initialize());
    const ix = plan.instruction;
    expect(ix.programAddress).toBe(programAddress);
    expect(ix.data.length).toBe(89);
    expect(hex(ix.data.slice(0, 8))).toBe("afaf6d1f0d989bed");
    expect(ix.data[8]).toBe(1);
    expect(ix.data.slice(9, 41)).toEqual(digest());
    expect(ix.data.slice(41, 73)).toEqual(new Uint8Array(getAddressEncoder().encode(wallet.address)));
    expect(hex(ix.data.slice(73))).toBe("0100000000002000ffffffffffffffff");
    expect(ix.accounts.map((meta) => [meta.address, meta.role])).toEqual([
      [payer.address, 3], [programAddress, 0], [plan.programData, 0], [plan.config, 1],
      [plan.mintAuthority, 0], [plan.featherMint, 1], [TOKEN_PROGRAM_ADDRESS, 0],
      ["11111111111111111111111111111111", 0], ["SysvarRent111111111111111111111111111111111", 0],
    ]);
    expect(getSignersFromInstruction(ix)).toEqual([payer]);
    expect((await buildInitializeInstruction({ ...initialize(), environment: 2 })).instruction.data[8]).toBe(2);
  });

  it("encodes authorization exact u64/i64 bounds with only issuer signing", async () => {
    const plan = await buildAuthorizeEnrollmentInstruction(authorize());
    const ix = plan.instruction;
    expect(ix.data.length).toBe(88);
    expect(hex(ix.data.slice(0, 8))).toBe("14888b7d2fa274c5");
    expect(ix.data.slice(8, 40)).toEqual(new Uint8Array(getAddressEncoder().encode(wallet.address)));
    expect(ix.data.slice(40, 72)).toEqual(digest());
    expect(hex(ix.data.slice(72))).toBe("ffffffffffffffffffffffffffffff7f");
    expect(ix.accounts.map((meta) => [meta.address, meta.role])).toEqual([
      [payer.address, 3], [plan.config, 1], [plan.enrollment, 1], [plan.identity, 1], ["11111111111111111111111111111111", 0],
    ]);
    expect(getSignersFromInstruction(ix)).toEqual([payer]);
  });

  it("claims with wallet readonly signer and canonical token-program ATA, no creation by default", async () => {
    const plan = await buildClaimFeathersInstructions({ programAddress, wallet });
    expect(plan.instructions).toEqual([plan.instruction]);
    expect(hex(plan.instruction.data)).toBe("b42b3f6bcd685d21");
    const [ata] = await getProgramDerivedAddress({ programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, seeds:
      [wallet.address, TOKEN_PROGRAM_ADDRESS, plan.featherMint].map((key) => getAddressEncoder().encode(key)) });
    expect(plan.walletTokens).toBe(ata);
    expect(plan.instruction.accounts.map((meta) => [meta.address, meta.role])).toEqual([
      [wallet.address, 2], [plan.config, 1], [plan.enrollment, 1], [plan.mintAuthority, 0],
      [plan.featherMint, 1], [ata, 1], [TOKEN_PROGRAM_ADDRESS, 0], [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, 0],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
  });

  it("optionally prepends idempotent ATA creation with separate or default payer, never replaces wallet signer", async () => {
    for (const explicitPayer of [undefined, payer]) {
      const plan = await buildClaimFeathersInstructions({ programAddress, wallet, createAta: true, payer: explicitPayer });
      expect(plan.instructions).toHaveLength(2);
      const create = plan.instructions[0]!;
      expect(Array.from(create.data!)).toEqual([1]);
      const parsed = parseCreateAssociatedTokenIdempotentInstruction<string, readonly AccountMeta[]>(create);
      expect(parsed.accounts.payer.address).toBe((explicitPayer ?? wallet).address);
      expect(parsed.accounts.ata.address).toBe(plan.walletTokens);
      expect(parsed.accounts.owner.address).toBe(wallet.address);
      expect(parsed.accounts.mint.address).toBe(plan.featherMint);
      expect(getSignersFromInstruction(create)).toEqual([explicitPayer ?? wallet]);
      expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
    }
  });

  it("rejects out-of-range/number amounts and incoherent caps before encoding", async () => {
    for (const value of [0n, -1n, maxU64 + 1n, 1 as unknown as bigint]) {
      await expect(buildInitializeInstruction({ ...initialize(), perWalletCap: value })).rejects.toThrow();
      await expect(buildInitializeInstruction({ ...initialize(), campaignCap: value })).rejects.toThrow();
      await expect(buildAuthorizeEnrollmentInstruction({ ...authorize(), allowance: value })).rejects.toThrow();
    }
    await expect(buildInitializeInstruction({ ...initialize(), campaignCap: 1n })).rejects.toThrow("cover");
    for (const expiresAt of [0n, -1n, 1n << 63n, 1 as unknown as bigint]) {
      await expect(buildAuthorizeEnrollmentInstruction({ ...authorize(), expiresAt })).rejects.toThrow("Expiry");
    }
  });

  it("rejects zero/incorrect digests, zero authorities, invalid environment and missing signer", async () => {
    for (const badDigest of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(32)]) {
      await expect(buildInitializeInstruction({ ...initialize(), genesisDomain: badDigest })).rejects.toThrow();
      await expect(buildAuthorizeEnrollmentInstruction({ ...authorize(), identityDigest: badDigest })).rejects.toThrow();
    }
    await expect(buildInitializeInstruction({ ...initialize(), enrollmentAuthority: address("11111111111111111111111111111111") })).rejects.toThrow("nonzero");
    await expect(buildAuthorizeEnrollmentInstruction({ ...authorize(), wallet: address("11111111111111111111111111111111") })).rejects.toThrow("nonzero");
    await expect(buildInitializeInstruction({ ...initialize(), environment: 0 as 1 })).rejects.toThrow("Environment");
    await expect(buildClaimFeathersInstructions({ programAddress, wallet: { address: wallet.address } as TransactionSigner })).rejects.toThrow();
    await expect(buildInitializeInstruction({ ...initialize(), programAddress: "bad" as typeof programAddress })).rejects.toThrow();
  });

  it("copies digest inputs before asynchronous derivation so PDA and encoded bytes cannot diverge", async () => {
    const input = authorize();
    const pending = buildAuthorizeEnrollmentInstruction(input);
    input.identityDigest.fill(9);
    const plan = await pending;
    expect(plan.instruction.data.slice(40, 72)).toEqual(digest());
    expect(plan.identity).toBe("HpaXT1uTsXcgwyq1iguV5qjsynFk4kS7gpVHQTPjct6g");
  });
});
