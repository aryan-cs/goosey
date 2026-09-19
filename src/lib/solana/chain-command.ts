import { createHash } from "node:crypto";

import { address, getBase58Decoder, signature } from "@solana/kit";

import type { SolanaRuntime } from "@/lib/solana/runtime";

export const CHAIN_COMMAND_STATUSES = [
  "ACCEPTED",
  "PREPARED",
  "SIGNED",
  "SUBMITTED",
  "CONFIRMED",
  "FINALIZED",
  "PROJECTED",
  "UNKNOWN",
  "FAILED_RETRYABLE",
  "FAILED_TERMINAL",
] as const;

export type ChainCommandStatus = (typeof CHAIN_COMMAND_STATUSES)[number];
export type ChainCommandScope = "USER" | "MARKET" | "SYSTEM";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REQUEST_BYTES = 65_536;
export const MAX_SOLANA_TRANSACTION_BYTES = 1_232;

export class ChainCommandValidationError extends Error {
  constructor(message = "Invalid chain command") {
    super(message);
    this.name = "ChainCommandValidationError";
  }
}

function boundedIdentifier(value: string, label: string, maximum = 191): string {
  if (!IDENTIFIER.test(value) || value.length > maximum || value !== value.normalize("NFC")) {
    throw new ChainCommandValidationError(`${label} must be a canonical bounded identifier`);
  }
  return value;
}

function canonicalJsonValue(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value !== value.normalize("NFC")) {
      throw new ChainCommandValidationError(`${path} contains a non-NFC string`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ChainCommandValidationError(`${path} numbers must be safe integers; encode chain integers as decimal strings`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    throw new ChainCommandValidationError(`${path} is not canonical JSON data`);
  }
  if (seen.has(value)) throw new ChainCommandValidationError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalJsonValue(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new ChainCommandValidationError(`${path} must contain only plain objects`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    for (const key of keys) {
      if (key !== key.normalize("NFC")) throw new ChainCommandValidationError(`${path} contains a non-NFC key`);
    }
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic, recursively key-sorted JSON. Values outside lossless JSON are rejected. */
export function canonicalChainCommandJson(value: unknown): string {
  const canonical = canonicalJsonValue(value, "$", new Set());
  if (Buffer.byteLength(canonical, "utf8") > MAX_REQUEST_BYTES) {
    throw new ChainCommandValidationError("Canonical request exceeds 65536 bytes");
  }
  return canonical;
}

export type AcceptChainCommandInput = Readonly<{
  runtime: Pick<SolanaRuntime, "cluster" | "genesisHash" | "programAddress">;
  scope: ChainCommandScope;
  scopeId: string;
  actorId: string;
  operation: string;
  idempotencyKey: string;
  request: unknown;
}>;

export type AcceptedChainCommandIdentity = Readonly<{
  cluster: "localnet" | "devnet";
  genesisHash: string;
  programAddress: string;
  scope: ChainCommandScope;
  scopeId: string;
  actorId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  requestJson: string;
}>;

/** Builds the immutable acceptance record used by a create-or-replay transaction. */
export function acceptChainCommand(input: AcceptChainCommandInput): AcceptedChainCommandIdentity {
  if (input.runtime.cluster !== "localnet" && input.runtime.cluster !== "devnet") {
    throw new ChainCommandValidationError("Only localnet and devnet chain commands are supported");
  }
  address(input.runtime.genesisHash);
  const programAddress = address(input.runtime.programAddress).toString();
  const scopeId = boundedIdentifier(input.scopeId, "scopeId");
  const actorId = boundedIdentifier(input.actorId, "actorId");
  const operation = boundedIdentifier(input.operation, "operation", 96);
  const idempotencyKey = boundedIdentifier(input.idempotencyKey, "idempotencyKey", 200);
  const requestJson = canonicalChainCommandJson({ version: 1, operation, request: input.request });
  return {
    cluster: input.runtime.cluster,
    genesisHash: input.runtime.genesisHash,
    programAddress,
    scope: input.scope,
    scopeId,
    actorId,
    operation,
    idempotencyKey,
    requestHash: createHash("sha256").update(requestJson).digest("hex"),
    requestJson,
  };
}

/** Fails closed if a scoped idempotency replay changes any immutable identity. */
export function assertChainCommandReplay(
  stored: AcceptedChainCommandIdentity,
  proposed: AcceptedChainCommandIdentity,
): void {
  for (const key of Object.keys(proposed) as Array<keyof AcceptedChainCommandIdentity>) {
    if (stored[key] !== proposed[key]) {
      throw new ChainCommandValidationError(`Idempotency replay changed immutable ${key}`);
    }
  }
}

function readShortU16(bytes: Uint8Array, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let index = start;
  for (; index < bytes.length && index < start + 3; index += 1) {
    const byte = bytes[index];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (index > start && byte === 0) throw new ChainCommandValidationError("Noncanonical compact length");
      return { value, next: index + 1 };
    }
    shift += 7;
  }
  throw new ChainCommandValidationError("Invalid compact length");
}

function publicKey(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new ChainCommandValidationError("Truncated transaction public key");
  return address(getBase58Decoder().decode(bytes)).toString();
}

export type SignedWireInput = Readonly<{
  commandId: string;
  sequence: number;
  leaseEpoch: number;
  commandRevision: number;
  signedWireBase64: string;
  transactionSignature: string;
  recentBlockhash: string;
  lastValidBlockHeight: bigint | null;
  durableNonceAddress: string | null;
  feePayerAddress: string;
  signerAddresses: readonly string[];
}>;

export type ChainCommandSignedWireRecord = Omit<SignedWireInput, "signerAddresses"> & Readonly<{
  wireVersion: "legacy" | "v0";
  signedWireByteLength: number;
  signedWireSha256: string;
  signerAddressesJson: string;
}>;

export type InspectedSignedSolanaWire = Readonly<{
  wire: Uint8Array;
  wireVersion: "legacy" | "v0";
  transactionSignature: string;
  recentBlockhash: string;
  feePayerAddress: string;
  signerAddresses: readonly string[];
}>;

/** Parses only immutable message metadata; it performs no RPC or signature verification. */
export function inspectSignedSolanaWire(signedWireBase64: string): InspectedSignedSolanaWire {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signedWireBase64) || signedWireBase64.length > 1_644) {
    throw new ChainCommandValidationError("Signed wire must be canonical bounded base64");
  }
  const wire = Buffer.from(signedWireBase64, "base64");
  if (wire.length < 1 || wire.length > MAX_SOLANA_TRANSACTION_BYTES || wire.toString("base64") !== signedWireBase64) {
    throw new ChainCommandValidationError("Signed wire must be canonical bounded base64");
  }
  const signatures = readShortU16(wire, 0);
  if (signatures.value < 1 || signatures.value > 32) throw new ChainCommandValidationError("Invalid signature count");
  const signatureEnd = signatures.next + signatures.value * 64;
  if (signatureEnd >= wire.length) throw new ChainCommandValidationError("Truncated signed transaction");
  const transactionSignature = signature(getBase58Decoder().decode(wire.subarray(signatures.next, signatures.next + 64))).toString();
  let offset = signatureEnd;
  const versionByte = wire[offset];
  const wireVersion = (versionByte & 0x80) === 0 ? "legacy" : versionByte === 0x80 ? "v0" : null;
  if (!wireVersion) throw new ChainCommandValidationError("Unsupported Solana transaction version");
  if (wireVersion === "v0") offset += 1;
  if (offset + 3 > wire.length) throw new ChainCommandValidationError("Truncated transaction header");
  const requiredSigners = wire[offset];
  offset += 3;
  if (requiredSigners !== signatures.value) throw new ChainCommandValidationError("Signature/header count mismatch");
  const accounts = readShortU16(wire, offset);
  offset = accounts.next;
  if (accounts.value < requiredSigners || accounts.value > 256 || offset + accounts.value * 32 + 32 > wire.length) {
    throw new ChainCommandValidationError("Invalid static account list");
  }
  const signerAddresses = Array.from({ length: requiredSigners }, (_, index) =>
    publicKey(wire.subarray(offset + index * 32, offset + (index + 1) * 32)));
  offset += accounts.value * 32;
  return {
    wire,
    wireVersion,
    transactionSignature,
    recentBlockhash: publicKey(wire.subarray(offset, offset + 32)),
    feePayerAddress: signerAddresses[0],
    signerAddresses,
  };
}

/** Validates metadata against the exact serialized Solana transaction bytes. */
export function createSignedWireJournal(input: SignedWireInput): ChainCommandSignedWireRecord {
  boundedIdentifier(input.commandId, "commandId");
  for (const [label, value] of [["sequence", input.sequence], ["leaseEpoch", input.leaseEpoch], ["commandRevision", input.commandRevision]] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
      throw new ChainCommandValidationError(`${label} is out of range`);
    }
  }
  const inspected = inspectSignedSolanaWire(input.signedWireBase64);
  if (signature(input.transactionSignature).toString() !== inspected.transactionSignature) {
    throw new ChainCommandValidationError("Transaction signature does not match signed wire");
  }
  const feePayerAddress = address(input.feePayerAddress).toString();
  const signerAddresses = input.signerAddresses.map(value => address(value).toString());
  if (feePayerAddress !== inspected.feePayerAddress || JSON.stringify(signerAddresses) !== JSON.stringify(inspected.signerAddresses)) {
    throw new ChainCommandValidationError("Fee payer or signer metadata does not match signed wire");
  }
  if (address(input.recentBlockhash).toString() !== inspected.recentBlockhash) {
    throw new ChainCommandValidationError("Recent blockhash does not match signed wire");
  }
  const hasBlockHeight = input.lastValidBlockHeight !== null;
  const hasDurableNonce = input.durableNonceAddress !== null;
  if (hasBlockHeight === hasDurableNonce) {
    throw new ChainCommandValidationError("Exactly one blockhash lifetime or durable nonce must be recorded");
  }
  if (input.lastValidBlockHeight !== null && (input.lastValidBlockHeight < 0n || input.lastValidBlockHeight > 9_223_372_036_854_775_807n)) {
    throw new ChainCommandValidationError("Last valid block height is out of range");
  }
  const durableNonceAddress = input.durableNonceAddress === null ? null : address(input.durableNonceAddress).toString();
  const signerAddressesJson = canonicalChainCommandJson(inspected.signerAddresses);
  if (Buffer.byteLength(signerAddressesJson) > 1_024) throw new ChainCommandValidationError("Signer metadata is too large");
  return {
    commandId: input.commandId,
    sequence: input.sequence,
    leaseEpoch: input.leaseEpoch,
    commandRevision: input.commandRevision,
    signedWireBase64: input.signedWireBase64,
    transactionSignature: inspected.transactionSignature,
    recentBlockhash: inspected.recentBlockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
    durableNonceAddress,
    feePayerAddress,
    wireVersion: inspected.wireVersion,
    signedWireByteLength: inspected.wire.length,
    signedWireSha256: createHash("sha256").update(inspected.wire).digest("hex"),
    signerAddressesJson,
  };
}

export function isSha256(value: string): boolean {
  return SHA256.test(value);
}
