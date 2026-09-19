import { address } from "@solana/kit";

import type { ProvisioningCheckpoint, ProvisioningOperation } from "@/lib/solana/account-provisioning";
import {
  acceptChainCommand,
  ChainCommandValidationError,
  createSignedWireJournal,
  inspectSignedSolanaWire,
  type AcceptedChainCommandIdentity,
  type ChainCommandSignedWireRecord,
} from "@/lib/solana/chain-command";

const U64_MAX = 18_446_744_073_709_551_615n;
const I64_MAX = 9_223_372_036_854_775_807n;

export type ProvisioningChainOperation = "ENROLLMENT" | "CLAIM";

function operationName(operation: ProvisioningOperation): ProvisioningChainOperation {
  return operation === "enrollment" ? "ENROLLMENT" : "CLAIM";
}

function decimal(value: string, label: string, maximum: bigint): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new ChainCommandValidationError(`Invalid provisioning ${label}`);
  const parsed = BigInt(value);
  if (parsed > maximum) throw new ChainCommandValidationError(`Invalid provisioning ${label}`);
  return value;
}

function validateCheckpoint(checkpoint: ProvisioningCheckpoint): "localnet" | "devnet" {
  if (checkpoint.version !== 1) throw new ChainCommandValidationError("Unsupported provisioning checkpoint version");
  const cluster = checkpoint.chainId === "solana:localnet" ? "localnet"
    : checkpoint.chainId === "solana:devnet" ? "devnet" : null;
  if (!cluster) throw new ChainCommandValidationError("Provisioning checkpoint is not localnet or devnet");
  address(checkpoint.genesisHash);
  for (const value of [checkpoint.programAddress, checkpoint.walletAddress, checkpoint.enrollmentAuthority, checkpoint.sponsor]) {
    address(value);
  }
  if (!/^[a-f0-9]{64}$/.test(checkpoint.identityDigestHex) || /^0+$/.test(checkpoint.identityDigestHex)) {
    throw new ChainCommandValidationError("Invalid provisioning identity digest");
  }
  decimal(checkpoint.allowance, "allowance", U64_MAX);
  decimal(checkpoint.expiresAt, "expiry", I64_MAX);
  return cluster;
}

/** Freezes the checkpoint intent into one scoped, replay-safe command identity. */
export function provisioningChainCommand(
  checkpoint: ProvisioningCheckpoint,
  operation: ProvisioningOperation,
): AcceptedChainCommandIdentity {
  const cluster = validateCheckpoint(checkpoint);
  const commandOperation = operationName(operation);
  return acceptChainCommand({
    runtime: { cluster, genesisHash: checkpoint.genesisHash, programAddress: address(checkpoint.programAddress) },
    scope: "USER",
    scopeId: checkpoint.userId,
    actorId: checkpoint.userId,
    operation: commandOperation,
    idempotencyKey: `provisioning:v1:${operation}`,
    request: {
      checkpointVersion: checkpoint.version,
      chainId: checkpoint.chainId,
      walletAddress: checkpoint.walletAddress,
      identityDigestHex: checkpoint.identityDigestHex,
      allowance: checkpoint.allowance,
      expiresAt: checkpoint.expiresAt,
      enrollmentAuthority: checkpoint.enrollmentAuthority,
      sponsor: checkpoint.sponsor,
    },
  });
}

/**
 * Converts a checkpoint's pending receipt into the exact append-only wire row.
 * Signer roles are checked against the serialized transaction, not trusted from
 * checkpoint metadata.
 */
export function provisioningSignedWireJournal(checkpoint: ProvisioningCheckpoint, input: Readonly<{
  commandId: string;
  sequence: number;
  leaseEpoch: number;
  commandRevision: number;
}>): ChainCommandSignedWireRecord {
  validateCheckpoint(checkpoint);
  if (!checkpoint.pending) throw new ChainCommandValidationError("Provisioning checkpoint has no pending signed receipt");
  const inspected = inspectSignedSolanaWire(checkpoint.pending.signedWireBase64);
  const expectedSigners = checkpoint.pending.operation === "enrollment"
    ? [checkpoint.sponsor, checkpoint.enrollmentAuthority]
    : [checkpoint.sponsor, checkpoint.walletAddress];
  if (inspected.feePayerAddress !== checkpoint.sponsor
    || inspected.signerAddresses.length !== expectedSigners.length
    || !expectedSigners.every(expected => inspected.signerAddresses.includes(expected))) {
    throw new ChainCommandValidationError("Provisioning signed wire does not match its frozen signer roles");
  }
  return createSignedWireJournal({
    ...input,
    signedWireBase64: checkpoint.pending.signedWireBase64,
    transactionSignature: checkpoint.pending.signature,
    recentBlockhash: inspected.recentBlockhash,
    lastValidBlockHeight: checkpoint.pending.lastValidBlockHeight,
    durableNonceAddress: null,
    feePayerAddress: checkpoint.sponsor,
    signerAddresses: inspected.signerAddresses,
  });
}
