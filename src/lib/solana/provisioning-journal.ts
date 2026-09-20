import { address, signature } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import type { ProvisioningCheckpoint, ProvisioningJournal } from "@/lib/solana/account-provisioning";

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const decimal = (maximum: bigint) => z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= maximum);

const storedSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  chainId: z.enum(["solana:localnet", "solana:devnet"]),
  genesisHash: z.string().min(32).max(64),
  programAddress: z.string().min(32).max(64),
  walletAddress: z.string().min(32).max(64),
  identityDigestHex: z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/^0+$/.test(value)),
  allowance: decimal(U64_MAX).refine(value => BigInt(value) > 0n),
  expiresAt: decimal(I64_MAX).refine(value => BigInt(value) > 0n),
  enrollmentAuthority: z.string().min(32).max(64),
  sponsor: z.string().min(32).max(64),
  pending: z.object({
    operation: z.enum(["enrollment", "claim"]),
    signature: z.string().min(64).max(96),
    signedWireBase64: z.string().min(1).max(1_644).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    lastValidBlockHeight: decimal(U64_MAX),
  }).strict().nullable(),
}).strict();

type StoredCheckpoint = z.infer<typeof storedSchema>;

function validateAddresses(value: StoredCheckpoint) {
  for (const item of [value.genesisHash, value.programAddress, value.walletAddress,
    value.enrollmentAuthority, value.sponsor]) address(item);
  if (value.pending) signature(value.pending.signature);
}

export function encodeProvisioningCheckpoint(checkpoint: ProvisioningCheckpoint): string {
  const stored: StoredCheckpoint = {
    version: checkpoint.version,
    userId: checkpoint.userId,
    chainId: checkpoint.chainId,
    genesisHash: checkpoint.genesisHash,
    programAddress: checkpoint.programAddress,
    walletAddress: checkpoint.walletAddress,
    identityDigestHex: checkpoint.identityDigestHex,
    allowance: checkpoint.allowance,
    expiresAt: checkpoint.expiresAt,
    enrollmentAuthority: checkpoint.enrollmentAuthority,
    sponsor: checkpoint.sponsor,
    pending: checkpoint.pending ? {
      operation: checkpoint.pending.operation,
      signature: checkpoint.pending.signature,
      signedWireBase64: checkpoint.pending.signedWireBase64,
      lastValidBlockHeight: checkpoint.pending.lastValidBlockHeight.toString(),
    } : null,
  };
  const parsed = storedSchema.parse(stored);
  validateAddresses(parsed);
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > 20_000) throw new Error("Provisioning checkpoint is too large");
  return encoded;
}

export function decodeProvisioningCheckpoint(encoded: string): ProvisioningCheckpoint {
  if (typeof encoded !== "string" || Buffer.byteLength(encoded, "utf8") > 20_000) {
    throw new Error("Stored provisioning checkpoint is invalid");
  }
  let json: unknown;
  try { json = JSON.parse(encoded); } catch { throw new Error("Stored provisioning checkpoint is invalid"); }
  const stored = storedSchema.parse(json);
  validateAddresses(stored);
  return Object.freeze({ ...stored, pending: stored.pending ? Object.freeze({ ...stored.pending,
    lastValidBlockHeight: BigInt(stored.pending.lastValidBlockHeight) }) : null });
}

function immutableIntent(checkpoint: ProvisioningCheckpoint) {
  const { pending: _pending, ...intent } = checkpoint;
  void _pending;
  return JSON.stringify(intent);
}

type JournalDatabase = TransactionRunner & Pick<typeof db, "solanaProvisioningCheckpoint">;

export class PrismaProvisioningJournal implements ProvisioningJournal {
  private readonly revisions = new WeakMap<object, number>();

  constructor(private readonly database: JournalDatabase = db) {}

  async load(scope: Readonly<{ userId: string; chainId: ProvisioningCheckpoint["chainId"]; genesisHash: string }>) {
    const row = await runSerializableTransaction(this.database, tx => tx.solanaProvisioningCheckpoint.findUnique({
      where: { userId_chainId_genesisHash: scope },
      select: { revision: true, checkpointJson: true },
    }));
    if (!row) return null;
    const checkpoint = decodeProvisioningCheckpoint(row.checkpointJson);
    if (checkpoint.userId !== scope.userId || checkpoint.chainId !== scope.chainId
      || checkpoint.genesisHash !== scope.genesisHash) throw new Error("Provisioning checkpoint scope mismatch");
    this.revisions.set(checkpoint, row.revision);
    return checkpoint;
  }

  async save(expected: ProvisioningCheckpoint | null, next: ProvisioningCheckpoint): Promise<void> {
    const nextJson = encodeProvisioningCheckpoint(next);
    if (expected === null) {
      if (next.pending !== null) throw new Error("Initial provisioning checkpoint cannot contain a pending transaction");
      try {
        await runSerializableTransaction(this.database, tx => tx.solanaProvisioningCheckpoint.create({
          data: { userId: next.userId, chainId: next.chainId, genesisHash: next.genesisHash, checkpointJson: nextJson },
        }));
      } catch (error) {
        if (isPrismaErrorCode(error, "P2002")) throw new Error("Provisioning checkpoint compare-and-set conflict");
        throw error;
      }
      this.revisions.set(next, 0);
      return;
    }
    if (immutableIntent(expected) !== immutableIntent(next)) {
      throw new Error("Provisioning checkpoint intent is immutable");
    }
    const revision = this.revisions.get(expected);
    if (revision === undefined) throw new Error("Provisioning checkpoint was not loaded by this journal");
    const expectedJson = encodeProvisioningCheckpoint(expected);
    const changed = await runSerializableTransaction(this.database, tx => tx.solanaProvisioningCheckpoint.updateMany({
      where: {
        userId: expected.userId,
        chainId: expected.chainId,
        genesisHash: expected.genesisHash,
        revision,
        checkpointJson: expectedJson,
      },
      data: { revision: { increment: 1 }, checkpointJson: nextJson },
    }));
    if (changed.count !== 1) throw new Error("Provisioning checkpoint compare-and-set conflict");
    this.revisions.set(next, revision + 1);
  }
}
