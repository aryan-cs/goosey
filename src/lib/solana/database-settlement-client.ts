import {
  AccountRole,
  address,
  assertIsTransactionSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";

export const DATABASE_SETTLEMENT_CONFIG_ACCOUNT_BYTES = 106;
export const DATABASE_SETTLEMENT_ATTESTATION_ACCOUNT_BYTES = 163;
export type DatabaseSettlementOutcome = "YES" | "NO" | "VOID";

export type DatabaseSettlementConfigBinding = {
  programAddress: Address;
  config: Address;
  authority: Address;
  databaseDomain: Uint8Array;
};

export type DatabaseSettlementAttestationBinding = {
  programAddress: Address;
  config: Address;
  attestationConfig: Address;
  authority: Address;
  databaseMarketDigest: Uint8Array;
  settlementDigest: Uint8Array;
  outcome: DatabaseSettlementOutcome;
  totalPositions: bigint;
  totalPayoutMilli: bigint;
  resolvedAt: bigint;
};

const enc = getAddressEncoder();
const dec = getAddressDecoder();
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

function key(value: Address, label = "settlement identity"): Address {
  const result = address(value);
  if (result === SYSTEM_PROGRAM_ADDRESS) throw new Error(`${label} must be nonzero`);
  return result;
}

function digest(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32 || !value.some(byte => byte !== 0)) {
    throw new Error(`${label} must be a nonzero 32-byte digest`);
  }
  return new Uint8Array(value);
}

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function u64(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) throw new Error(`${label} is outside u64`);
  return value;
}

function positiveI64(value: bigint): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > I64_MAX) throw new Error("resolvedAt must be a positive i64");
  return value;
}

function outcomeByte(value: DatabaseSettlementOutcome): number {
  if (value === "YES") return 0;
  if (value === "NO") return 1;
  if (value === "VOID") return 2;
  throw new Error("Invalid database settlement outcome");
}

function outcomeValue(value: number): DatabaseSettlementOutcome {
  if (value === 0) return "YES";
  if (value === 1) return "NO";
  if (value === 2) return "VOID";
  throw new Error("Invalid database settlement outcome byte");
}

function littleEndian(value: bigint, signed: boolean) {
  const result = new Uint8Array(8);
  const view = new DataView(result.buffer);
  if (signed) view.setBigInt64(0, value, true);
  else view.setBigUint64(0, value, true);
  return result;
}

async function discriminator(namespace: "global" | "account", name: string) {
  const input = new TextEncoder().encode(`${namespace}:${name}`);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input)).slice(0, 8);
}

async function instructionData(name: string, fields: readonly Uint8Array[]) {
  const result = new Uint8Array(8 + fields.reduce((size, field) => size + field.length, 0));
  result.set(await discriminator("global", name));
  let offset = 8;
  for (const field of fields) {
    result.set(field, offset);
    offset += field.length;
  }
  return result;
}

const meta = (value: Address, writable = false) => ({
  address: value,
  role: writable ? AccountRole.WRITABLE : AccountRole.READONLY,
});

function signer(value: TransactionSigner) {
  assertIsTransactionSigner(value);
  return { address: key(value.address, "authority"), signer: value, role: AccountRole.WRITABLE_SIGNER } as const;
}

function stableSigner(value: ReturnType<typeof signer>) {
  if (value.signer.address !== value.address) throw new Error("Signer identity changed during settlement construction");
}

export async function deriveGooseyDatabaseSettlementConfigAddresses(input: { programAddress: Address }) {
  const programAddress = key(input.programAddress, "program address");
  const [config] = await getProgramDerivedAddress({ programAddress, seeds: ["config"] });
  const [attestationConfig, attestationConfigBump] = await getProgramDerivedAddress({
    programAddress,
    seeds: ["db_settlement_config", enc.encode(config)],
  });
  return { programAddress, config, attestationConfig, attestationConfigBump };
}

export async function deriveGooseyDatabaseSettlementAttestationAddresses(input: {
  programAddress: Address;
  databaseMarketDigest: Uint8Array;
}) {
  const programAddress = key(input.programAddress, "program address");
  const marketDigest = digest(input.databaseMarketDigest, "databaseMarketDigest");
  const base = await deriveGooseyDatabaseSettlementConfigAddresses({ programAddress });
  const [attestation, attestationBump] = await getProgramDerivedAddress({
    programAddress,
    seeds: ["db_settlement", enc.encode(base.attestationConfig), marketDigest],
  });
  return { ...base, attestation, attestationBump };
}

/**
 * Builds the unsigned one-time configuration instruction. `databaseDomain` is
 * a public deployment-domain digest used for domain separation, not a secret.
 */
export async function buildInitializeDatabaseSettlementAttestationConfigInstruction(input: {
  programAddress: Address;
  admin: TransactionSigner;
  authority: Address;
  enrollmentAuthority: Address;
  databaseDomain: Uint8Array;
}) {
  const programAddress = key(input.programAddress, "program address");
  const admin = signer(input.admin);
  const authority = key(input.authority, "attestation authority");
  const enrollmentAuthority = key(input.enrollmentAuthority, "enrollment authority");
  const databaseDomain = digest(input.databaseDomain, "databaseDomain");
  if (authority === admin.address || authority === enrollmentAuthority) {
    throw new Error("Attestation authority must be independent from configuration authorities");
  }
  const derived = await deriveGooseyDatabaseSettlementConfigAddresses({ programAddress });
  const payload = await instructionData("initialize_database_settlement_attestation_config", [
    new Uint8Array(enc.encode(authority)),
    databaseDomain,
  ]);
  stableSigner(admin);
  const instruction = {
    programAddress,
    accounts: [admin, meta(derived.config), meta(derived.attestationConfig, true), meta(SYSTEM_PROGRAM_ADDRESS)],
    data: payload,
  } satisfies Instruction;
  return { ...derived, authority, databaseDomain, instruction };
}

/** Pure unsigned ABI construction; it performs no RPC, signing, or finality check. */
export async function buildAttestDatabaseSettlementInstruction(input: {
  programAddress: Address;
  authority: TransactionSigner;
  databaseMarketDigest: Uint8Array;
  settlementDigest: Uint8Array;
  outcome: DatabaseSettlementOutcome;
  totalPositions: bigint;
  totalPayoutMilli: bigint;
  resolvedAt: bigint;
}) {
  const programAddress = key(input.programAddress, "program address");
  const authority = signer(input.authority);
  const databaseMarketDigest = digest(input.databaseMarketDigest, "databaseMarketDigest");
  const settlementDigest = digest(input.settlementDigest, "settlementDigest");
  if (sameBytes(databaseMarketDigest, settlementDigest)) throw new Error("Database and settlement digests must differ");
  const encodedOutcome = outcomeByte(input.outcome);
  const totalPositions = u64(input.totalPositions, "totalPositions");
  const totalPayoutMilli = u64(input.totalPayoutMilli, "totalPayoutMilli");
  const resolvedAt = positiveI64(input.resolvedAt);
  const derived = await deriveGooseyDatabaseSettlementAttestationAddresses({ programAddress, databaseMarketDigest });
  const payload = await instructionData("attest_database_settlement", [
    databaseMarketDigest,
    settlementDigest,
    new Uint8Array([encodedOutcome]),
    littleEndian(totalPositions, false),
    littleEndian(totalPayoutMilli, false),
    littleEndian(resolvedAt, true),
  ]);
  stableSigner(authority);
  const instruction = {
    programAddress,
    accounts: [authority, meta(derived.config), meta(derived.attestationConfig), meta(derived.attestation, true), meta(SYSTEM_PROGRAM_ADDRESS)],
    data: payload,
  } satisfies Instruction;
  return {
    ...derived,
    databaseMarketDigest,
    settlementDigest,
    outcome: input.outcome,
    totalPositions,
    totalPayoutMilli,
    resolvedAt,
    instruction,
  };
}

type RawAccount = { address: Address; owner: Address; executable: boolean; data: Uint8Array };

function accountSnapshot(account: RawAccount, bytes: number) {
  const accountAddress = key(account.address, "account address");
  const owner = key(account.owner, "account owner");
  if (account.executable !== false || !(account.data instanceof Uint8Array) || account.data.length !== bytes) {
    throw new Error("Invalid database settlement account envelope");
  }
  return { accountAddress, owner, data: new Uint8Array(account.data) };
}

/** Strict pure decoder. The expected binding must come from trusted deployment configuration. */
export async function readDatabaseSettlementAttestationConfigAccount(binding: DatabaseSettlementConfigBinding, account: RawAccount) {
  const expected = {
    programAddress: key(binding.programAddress, "program address"),
    config: key(binding.config, "config"),
    authority: key(binding.authority, "attestation authority"),
    databaseDomain: digest(binding.databaseDomain, "databaseDomain"),
  };
  const snapshot = accountSnapshot(account, DATABASE_SETTLEMENT_CONFIG_ACCOUNT_BYTES);
  if (snapshot.owner !== expected.programAddress) throw new Error("Invalid database settlement config owner");
  const derived = await deriveGooseyDatabaseSettlementConfigAddresses({ programAddress: expected.programAddress });
  if (derived.config !== expected.config || derived.attestationConfig !== snapshot.accountAddress) {
    throw new Error("Noncanonical database settlement config PDA");
  }
  const disc = await discriminator("account", "DatabaseSettlementAttestationConfig");
  if (!sameBytes(snapshot.data.subarray(0, 8), disc)) throw new Error("Invalid database settlement config discriminator");
  if (snapshot.data[8] !== 1) throw new Error("Unsupported database settlement config version");
  const storedConfig = key(dec.decode(snapshot.data.subarray(9, 41)), "stored config");
  const authority = key(dec.decode(snapshot.data.subarray(41, 73)), "stored authority");
  const databaseDomain = digest(snapshot.data.slice(73, 105), "stored databaseDomain");
  const bump = snapshot.data[105];
  if (storedConfig !== expected.config || authority !== expected.authority || !sameBytes(databaseDomain, expected.databaseDomain)) {
    throw new Error("Database settlement config binding mismatch");
  }
  if (bump !== derived.attestationConfigBump) throw new Error("Invalid database settlement config bump");
  return { address: snapshot.accountAddress, version: 1 as const, config: storedConfig, authority, databaseDomain, bump };
}

/** Strict pure decoder. It validates all immutable settlement fields and canonical PDAs. */
export async function readDatabaseSettlementAttestationAccount(binding: DatabaseSettlementAttestationBinding, account: RawAccount) {
  const expected = {
    programAddress: key(binding.programAddress, "program address"),
    config: key(binding.config, "config"),
    attestationConfig: key(binding.attestationConfig, "attestation config"),
    authority: key(binding.authority, "attestation authority"),
    databaseMarketDigest: digest(binding.databaseMarketDigest, "databaseMarketDigest"),
    settlementDigest: digest(binding.settlementDigest, "settlementDigest"),
    outcome: binding.outcome,
    totalPositions: u64(binding.totalPositions, "totalPositions"),
    totalPayoutMilli: u64(binding.totalPayoutMilli, "totalPayoutMilli"),
    resolvedAt: positiveI64(binding.resolvedAt),
  };
  if (sameBytes(expected.databaseMarketDigest, expected.settlementDigest)) throw new Error("Database and settlement digests must differ");
  outcomeByte(expected.outcome);
  const snapshot = accountSnapshot(account, DATABASE_SETTLEMENT_ATTESTATION_ACCOUNT_BYTES);
  if (snapshot.owner !== expected.programAddress) throw new Error("Invalid database settlement attestation owner");
  const derived = await deriveGooseyDatabaseSettlementAttestationAddresses({
    programAddress: expected.programAddress,
    databaseMarketDigest: expected.databaseMarketDigest,
  });
  if (derived.config !== expected.config || derived.attestationConfig !== expected.attestationConfig || derived.attestation !== snapshot.accountAddress) {
    throw new Error("Noncanonical database settlement attestation PDA");
  }
  const disc = await discriminator("account", "DatabaseSettlementAttestation");
  if (!sameBytes(snapshot.data.subarray(0, 8), disc)) throw new Error("Invalid database settlement attestation discriminator");
  if (snapshot.data[8] !== 1) throw new Error("Unsupported database settlement attestation version");
  const storedConfig = key(dec.decode(snapshot.data.subarray(9, 41)), "stored config");
  const authority = key(dec.decode(snapshot.data.subarray(41, 73)), "stored authority");
  const databaseMarketDigest = digest(snapshot.data.slice(73, 105), "stored databaseMarketDigest");
  const settlementDigest = digest(snapshot.data.slice(105, 137), "stored settlementDigest");
  const outcome = outcomeValue(snapshot.data[137]);
  const view = new DataView(snapshot.data.buffer, snapshot.data.byteOffset, snapshot.data.byteLength);
  const totalPositions = view.getBigUint64(138, true);
  const totalPayoutMilli = view.getBigUint64(146, true);
  const resolvedAt = view.getBigInt64(154, true);
  const bump = snapshot.data[162];
  if (sameBytes(databaseMarketDigest, settlementDigest) || resolvedAt <= 0n) throw new Error("Invalid stored database settlement fields");
  if (storedConfig !== expected.config || authority !== expected.authority
    || !sameBytes(databaseMarketDigest, expected.databaseMarketDigest)
    || !sameBytes(settlementDigest, expected.settlementDigest)
    || outcome !== expected.outcome || totalPositions !== expected.totalPositions
    || totalPayoutMilli !== expected.totalPayoutMilli || resolvedAt !== expected.resolvedAt) {
    throw new Error("Database settlement attestation binding mismatch");
  }
  if (bump !== derived.attestationBump) throw new Error("Invalid database settlement attestation bump");
  return { address: snapshot.accountAddress, version: 1 as const, config: storedConfig, authority, databaseMarketDigest,
    settlementDigest, outcome, totalPositions, totalPayoutMilli, resolvedAt, bump };
}
