import { createHash } from "node:crypto";
import { AccountRole, address, createNoopSigner, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  DATABASE_SETTLEMENT_ATTESTATION_ACCOUNT_BYTES,
  DATABASE_SETTLEMENT_CONFIG_ACCOUNT_BYTES,
  buildAttestDatabaseSettlementInstruction,
  buildInitializeDatabaseSettlementAttestationConfigInstruction,
  deriveGooseyDatabaseSettlementAttestationAddresses,
  deriveGooseyDatabaseSettlementConfigAddresses,
  readDatabaseSettlementAttestationAccount,
  readDatabaseSettlementAttestationConfigAccount,
} from "./database-settlement-client";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = (value: number) => getAddressDecoder().decode(new Uint8Array(32).fill(value));
const admin = createNoopSigner(wallet(1));
const authority = createNoopSigner(wallet(2));
const enrollmentAuthority = wallet(3);
const marketDigest = () => new Uint8Array(32).fill(0x44);
const settlementDigest = () => new Uint8Array(32).fill(0x55);
const domain = () => new Uint8Array(32).fill(0x66);
const disc = (value: string) => createHash("sha256").update(value).digest().subarray(0, 8);
const enc = getAddressEncoder();
const ro = AccountRole.READONLY;
const rw = AccountRole.WRITABLE;

const attestInput = () => ({
  programAddress,
  authority,
  databaseMarketDigest: marketDigest(),
  settlementDigest: settlementDigest(),
  outcome: "YES" as const,
  totalPositions: 17n,
  totalPayoutMilli: 1_234_567n,
  resolvedAt: 1_800_000_000n,
});

describe("database settlement attestation ABI", () => {
  it("derives config and attestation PDAs from the exact Rust seeds", async () => {
    const base = await deriveGooseyDatabaseSettlementConfigAddresses({ programAddress });
    const [config] = await getProgramDerivedAddress({ programAddress, seeds: ["config"] });
    const attestationConfig = await getProgramDerivedAddress({ programAddress, seeds: ["db_settlement_config", enc.encode(config)] });
    expect(base).toEqual({ programAddress, config, attestationConfig: attestationConfig[0], attestationConfigBump: attestationConfig[1] });
    const derived = await deriveGooseyDatabaseSettlementAttestationAddresses({ programAddress, databaseMarketDigest: marketDigest() });
    const attestation = await getProgramDerivedAddress({ programAddress, seeds: ["db_settlement", enc.encode(attestationConfig[0]), marketDigest()] });
    expect([derived.attestation, derived.attestationBump]).toEqual(attestation);
  });

  it("encodes initialization discriminator, Borsh args, and account roles exactly", async () => {
    const value = await buildInitializeDatabaseSettlementAttestationConfigInstruction({
      programAddress, admin, authority: authority.address, enrollmentAuthority, databaseDomain: domain(),
    });
    expect(Buffer.from(value.instruction.data)).toEqual(Buffer.concat([
      disc("global:initialize_database_settlement_attestation_config"),
      Buffer.from(enc.encode(authority.address)),
      domain(),
    ]));
    expect(value.instruction.accounts.map(account => [account.address, account.role])).toEqual([
      [admin.address, AccountRole.WRITABLE_SIGNER], [value.config, ro], [value.attestationConfig, rw],
      ["11111111111111111111111111111111", ro],
    ]);
    expect(value.instruction.data.length).toBe(72);
  });

  it.each(["YES", "NO", "VOID"] as const)("encodes %s attestation and exact account order", async outcome => {
    const value = await buildAttestDatabaseSettlementInstruction({ ...attestInput(), outcome });
    const expected = Buffer.alloc(97);
    disc("global:attest_database_settlement").copy(expected);
    expected.set(marketDigest(), 8);
    expected.set(settlementDigest(), 40);
    expected[72] = { YES: 0, NO: 1, VOID: 2 }[outcome];
    expected.writeBigUInt64LE(17n, 73);
    expected.writeBigUInt64LE(1_234_567n, 81);
    expected.writeBigInt64LE(1_800_000_000n, 89);
    expect(Buffer.from(value.instruction.data)).toEqual(expected);
    expect(value.instruction.accounts.map(account => [account.address, account.role])).toEqual([
      [authority.address, AccountRole.WRITABLE_SIGNER], [value.config, ro], [value.attestationConfig, ro],
      [value.attestation, rw], ["11111111111111111111111111111111", ro],
    ]);
  });

  it("captures mutable digests and signer identity before awaits", async () => {
    const input = attestInput();
    const pending = buildAttestDatabaseSettlementInstruction(input);
    input.databaseMarketDigest.fill(1);
    input.settlementDigest.fill(2);
    expect((await pending).databaseMarketDigest).toEqual(marketDigest());
    const mutableSigner = { ...authority, address: authority.address };
    const unstable = buildAttestDatabaseSettlementInstruction({ ...attestInput(), authority: mutableSigner });
    mutableSigner.address = wallet(9);
    await expect(unstable).rejects.toThrow("Signer identity changed");
  });

  it("rejects invalid digests, scalar bounds, outcomes, and non-independent authority", async () => {
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), databaseMarketDigest: new Uint8Array(32) })).rejects.toThrow();
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), settlementDigest: marketDigest() })).rejects.toThrow();
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), totalPositions: -1n })).rejects.toThrow();
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), totalPayoutMilli: 1n << 64n })).rejects.toThrow();
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), resolvedAt: 0n })).rejects.toThrow();
    await expect(buildAttestDatabaseSettlementInstruction({ ...attestInput(), outcome: "MAYBE" as "YES" })).rejects.toThrow();
    await expect(buildInitializeDatabaseSettlementAttestationConfigInstruction({
      programAddress, admin, authority: admin.address, enrollmentAuthority, databaseDomain: domain(),
    })).rejects.toThrow("independent");
  });
});

async function fixture() {
  const derived = await deriveGooseyDatabaseSettlementAttestationAddresses({ programAddress, databaseMarketDigest: marketDigest() });
  const configBytes = Buffer.alloc(DATABASE_SETTLEMENT_CONFIG_ACCOUNT_BYTES);
  configBytes.set(disc("account:DatabaseSettlementAttestationConfig"));
  configBytes[8] = 1;
  configBytes.set(enc.encode(derived.config), 9);
  configBytes.set(enc.encode(authority.address), 41);
  configBytes.set(domain(), 73);
  configBytes[105] = derived.attestationConfigBump;
  const attestationBytes = Buffer.alloc(DATABASE_SETTLEMENT_ATTESTATION_ACCOUNT_BYTES);
  attestationBytes.set(disc("account:DatabaseSettlementAttestation"));
  attestationBytes[8] = 1;
  attestationBytes.set(enc.encode(derived.config), 9);
  attestationBytes.set(enc.encode(authority.address), 41);
  attestationBytes.set(marketDigest(), 73);
  attestationBytes.set(settlementDigest(), 105);
  attestationBytes[137] = 0;
  attestationBytes.writeBigUInt64LE(17n, 138);
  attestationBytes.writeBigUInt64LE(1_234_567n, 146);
  attestationBytes.writeBigInt64LE(1_800_000_000n, 154);
  attestationBytes[162] = derived.attestationBump;
  const configBinding = { programAddress, config: derived.config, authority: authority.address, databaseDomain: domain() };
  const attestationBinding = { ...attestInput(), config: derived.config, attestationConfig: derived.attestationConfig, authority: authority.address };
  const configAccount = { address: derived.attestationConfig, owner: programAddress as Address, executable: false, data: configBytes };
  const attestationAccount = { address: derived.attestation, owner: programAddress as Address, executable: false, data: attestationBytes };
  return { derived, configBytes, attestationBytes, configBinding, attestationBinding, configAccount, attestationAccount };
}

describe("strict database settlement account decoders", () => {
  it("decodes the fixed config and attestation layouts", async () => {
    const f = await fixture();
    expect(await readDatabaseSettlementAttestationConfigAccount(f.configBinding, f.configAccount)).toEqual({
      address: f.derived.attestationConfig, version: 1, config: f.derived.config, authority: authority.address,
      databaseDomain: domain(), bump: f.derived.attestationConfigBump,
    });
    expect(await readDatabaseSettlementAttestationAccount(f.attestationBinding, f.attestationAccount)).toEqual({
      address: f.derived.attestation, version: 1, config: f.derived.config, authority: authority.address,
      databaseMarketDigest: marketDigest(), settlementDigest: settlementDigest(), outcome: "YES",
      totalPositions: 17n, totalPayoutMilli: 1_234_567n, resolvedAt: 1_800_000_000n, bump: f.derived.attestationBump,
    });
  });

  it.each([0, 8, 9, 41, 73, 105, 137, 138, 146, 154, 162])("rejects attestation corruption at byte %s", async offset => {
    const f = await fixture();
    f.attestationBytes[offset] ^= 1;
    await expect(readDatabaseSettlementAttestationAccount(f.attestationBinding, f.attestationAccount)).rejects.toThrow();
  });

  it.each([0, 8, 9, 41, 73, 105])("rejects config corruption at byte %s", async offset => {
    const f = await fixture();
    f.configBytes[offset] ^= 1;
    await expect(readDatabaseSettlementAttestationConfigAccount(f.configBinding, f.configAccount)).rejects.toThrow();
  });

  it("rejects wrong owner, address, executable, truncation, and padding", async () => {
    const f = await fixture();
    for (const changed of [
      { owner: wallet(8) }, { address: wallet(8) }, { executable: true },
      { data: f.attestationBytes.subarray(0, 162) }, { data: Buffer.concat([f.attestationBytes, Buffer.from([0])]) },
    ]) {
      await expect(readDatabaseSettlementAttestationAccount(f.attestationBinding, { ...f.attestationAccount, ...changed })).rejects.toThrow();
    }
  });

  it("rejects noncanonical trusted bindings even when account bytes are changed to match", async () => {
    const f = await fixture();
    f.attestationBinding.config = wallet(8);
    f.attestationBytes.set(enc.encode(wallet(8)), 9);
    await expect(readDatabaseSettlementAttestationAccount(f.attestationBinding, f.attestationAccount)).rejects.toThrow("PDA");
  });

  it("snapshots account bytes and expected digests before asynchronous derivation", async () => {
    const f = await fixture();
    const pending = readDatabaseSettlementAttestationAccount(f.attestationBinding, f.attestationAccount);
    f.attestationBytes.fill(0);
    f.attestationBinding.databaseMarketDigest.fill(9);
    f.attestationAccount.owner = wallet(9);
    expect((await pending).settlementDigest).toEqual(settlementDigest());
  });
});
