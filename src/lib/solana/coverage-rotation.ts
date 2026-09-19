import { createHash, randomUUID } from "node:crypto";

import { address, signature } from "@solana/kit";
import type { PrismaClient, SolanaIngestionCursor } from "@prisma/client";

import { runSerializableTransaction, type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { solanaIndexerWorkerIdentity } from "@/lib/solana/indexer-health";
import { readFinalizedProgramEvents, type ProgramEventReadRpc } from "@/lib/solana/program-event-read";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";

const MAX_REVISION = 2_147_483_647;
const MAX_REASON_BYTES = 500;

type RotationClient = TransactionRunner & Pick<PrismaClient,
  "solanaIngestionCursor" | "solanaIngestionVisit" | "solanaTransactionReceipt" | "solanaCoverageRotation" | "workerState">;

export type CoverageRotationConfirmations = Readonly<{
  genesisHash: string;
  programAddress: string;
  oldBoundarySignature: string;
  oldCursorSha256?: string;
  newBoundarySignature: string;
}>;

export type CoverageRotationInput = Readonly<{
  runtime: SolanaRuntime;
  newBoundarySignature: string;
  enrolledWalletAddress: string;
  reason: string;
  confirmations: CoverageRotationConfirmations;
}>;

export type CoverageRotationOptions = Readonly<{
  client?: RotationClient;
  provider?: DatabaseProvider;
  rpc?: ProgramEventReadRpc;
  signal?: AbortSignal;
  id?: string;
}>;

export type CoverageCursorSnapshot = Readonly<{
  coverageStartSignature: string;
  committedHeadSignature: string | null;
  scanHeadSignature: string | null;
  scanBeforeSignature: string | null;
  backfillComplete: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

function deployment(runtime: SolanaRuntime) {
  const pinned = resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: runtime.cluster,
    GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash,
  });
  if (pinned.cluster !== "localnet") throw new Error("Coverage rotation is localnet-only; devnet and mainnet are unsupported");
  return pinned;
}

function reason(value: string) {
  if (value !== value.trim() || value.length < 10 || Buffer.byteLength(value) > MAX_REASON_BYTES
    || /[\0\r\n]/.test(value)) throw new Error("Rotation reason must be trimmed, single-line, and 10-500 bytes");
  return value;
}

function snapshot(cursor: SolanaIngestionCursor): CoverageCursorSnapshot {
  signature(cursor.coverageStartSignature);
  if (cursor.committedHeadSignature) signature(cursor.committedHeadSignature);
  if (cursor.scanHeadSignature) signature(cursor.scanHeadSignature);
  if (cursor.scanBeforeSignature) signature(cursor.scanBeforeSignature);
  if (!Number.isInteger(cursor.revision) || cursor.revision < 0 || cursor.revision > MAX_REVISION
    || cursor.backfillComplete !== (cursor.committedHeadSignature !== null)
    || (cursor.scanHeadSignature === null) !== (cursor.scanBeforeSignature === null)
    || !(cursor.createdAt instanceof Date) || !(cursor.updatedAt instanceof Date)) {
    throw new Error("Stored ingestion cursor is inconsistent");
  }
  return {
    coverageStartSignature: cursor.coverageStartSignature,
    committedHeadSignature: cursor.committedHeadSignature,
    scanHeadSignature: cursor.scanHeadSignature,
    scanBeforeSignature: cursor.scanBeforeSignature,
    backfillComplete: cursor.backfillComplete,
    revision: cursor.revision,
    createdAt: cursor.createdAt.toISOString(),
    updatedAt: cursor.updatedAt.toISOString(),
  };
}

export function coverageCursorSha256(value: CoverageCursorSnapshot) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validateConfirmations(input: CoverageRotationInput, runtime: SolanaRuntime) {
  const confirmations = input.confirmations;
  if (confirmations.genesisHash !== runtime.genesisHash
    || confirmations.programAddress !== runtime.programAddress.toString()) {
    throw new Error("Exact deployment confirmation does not match the configured localnet");
  }
  const newBoundary = signature(input.newBoundarySignature);
  if (signature(confirmations.newBoundarySignature) !== newBoundary) {
    throw new Error("Exact new boundary confirmation does not match");
  }
  if (confirmations.oldCursorSha256 !== undefined && !/^[a-f0-9]{64}$/.test(confirmations.oldCursorSha256)) {
    throw new Error("Invalid old cursor SHA-256 confirmation");
  }
  return { newBoundary, wallet: address(input.enrolledWalletAddress), reason: reason(input.reason) };
}

async function defaultClient(): Promise<RotationClient> {
  const { db, requireDatabaseStartup } = await import("@/lib/db");
  await requireDatabaseStartup();
  return db;
}

async function requireRotatableState(client: RotationClient, runtime: SolanaRuntime) {
  const domain = { genesisHash: runtime.genesisHash, programAddress: runtime.programAddress.toString() };
  const workerIdentity = solanaIndexerWorkerIdentity(runtime);
  const [cursor, worker, receiptCount, visitCount] = await Promise.all([
    client.solanaIngestionCursor.findUnique({ where: { genesisHash_programAddress: domain } }),
    client.workerState.findUnique({ where: { id: workerIdentity.workerId } }),
    client.solanaTransactionReceipt.count({ where: domain }),
    client.solanaIngestionVisit.count({ where: domain }),
  ]);
  if (!cursor) throw new Error("No existing ingestion cursor exists to rotate");
  const old = snapshot(cursor);
  if (worker?.status === "RUNNING") throw new Error("Stop the continuous indexer before rotating coverage");
  if (old.committedHeadSignature !== null || old.scanHeadSignature !== null || old.scanBeforeSignature !== null
    || old.backfillComplete || receiptCount !== 0 || visitCount !== 0) {
    throw new Error("Coverage rotation only supports an uncommitted cursor with no retained domain receipts or visits");
  }
  if (old.revision === MAX_REVISION) throw new Error("Ingestion cursor revision overflow");
  return { cursor, old, oldSha256: coverageCursorSha256(old), domain };
}

async function verifyEnrollmentBoundary(runtime: SolanaRuntime, transactionSignature: string, wallet: string,
  options: Pick<CoverageRotationOptions, "rpc" | "signal">) {
  const receipt = await readFinalizedProgramEvents(runtime, transactionSignature, {
    ...(options.rpc ? { rpc: options.rpc } : {}),
    signal: options.signal ?? AbortSignal.timeout(45_000),
  });
  if (receipt.outcome !== "success") throw new Error("New boundary is not a successful finalized Goosey transaction");
  const enrollments = receipt.records.filter(record => record.event.kind === "EnrollmentAuthorized");
  const matches = enrollments.filter(record => record.event.kind === "EnrollmentAuthorized"
    && record.event.wallet.toString() === wallet);
  if (enrollments.length !== 1 || matches.length !== 1) {
    throw new Error("New boundary must contain exactly one EnrollmentAuthorized event for the confirmed creator wallet");
  }
  const event = matches[0];
  if (event.event.kind !== "EnrollmentAuthorized") throw new Error("Enrollment boundary evidence mismatch");
  return {
    slot: receipt.slot,
    configurationSlot: receipt.configurationSlot,
    eventKey: event.eventKey,
    walletAddress: event.event.wallet.toString(),
    enrollmentAddress: event.event.enrollment.toString(),
  } as const;
}

/** Read-only preflight. Its digest must be repeated to the mutating command. */
export async function inspectCoverageRotation(input: CoverageRotationInput, options: CoverageRotationOptions = {}) {
  const runtime = deployment(input.runtime);
  const confirmed = validateConfirmations(input, runtime);
  const client = options.client ?? await defaultClient();
  const [state, evidence] = await Promise.all([
    requireRotatableState(client, runtime),
    verifyEnrollmentBoundary(runtime, confirmed.newBoundary, confirmed.wallet, options),
  ]);
  if (state.old.coverageStartSignature !== signature(input.confirmations.oldBoundarySignature)) {
    throw new Error("Exact old boundary confirmation does not match the stored cursor");
  }
  if (input.confirmations.oldCursorSha256 !== undefined && state.oldSha256 !== input.confirmations.oldCursorSha256) {
    throw new Error("Exact old cursor digest confirmation does not match the stored cursor");
  }
  if (state.old.coverageStartSignature === confirmed.newBoundary) throw new Error("New coverage boundary must differ from the old boundary");
  return { runtime: { cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress.toString() }, oldCursor: state.old, oldCursorSha256: state.oldSha256,
  newBoundary: { signature: confirmed.newBoundary, ...evidence }, fullHistory: false as const };
}

/** Atomically appends immutable evidence and CAS-rotates the empty cursor. */
export async function rotateCoverageBoundary(input: CoverageRotationInput, options: CoverageRotationOptions = {}) {
  const runtime = deployment(input.runtime);
  const confirmed = validateConfirmations(input, runtime);
  if (!input.confirmations.oldCursorSha256) throw new Error("Exact old cursor SHA-256 confirmation is required to apply a rotation");
  const client = options.client ?? await defaultClient();
  const evidence = await verifyEnrollmentBoundary(runtime, confirmed.newBoundary, confirmed.wallet, options);
  const result = await runSerializableTransaction(client, async tx => {
    const state = await requireRotatableState(tx as unknown as RotationClient, runtime);
    if (state.old.coverageStartSignature !== signature(input.confirmations.oldBoundarySignature)
      || state.oldSha256 !== input.confirmations.oldCursorSha256) {
      throw new Error("Stored cursor changed after operator inspection; inspect and confirm again");
    }
    if (state.old.coverageStartSignature === confirmed.newBoundary) throw new Error("New coverage boundary must differ from the old boundary");
    const rotation = await tx.solanaCoverageRotation.create({ data: {
      id: options.id ?? randomUUID(), ...state.domain,
      previousCoverageStartSignature: state.old.coverageStartSignature,
      previousCommittedHeadSignature: state.old.committedHeadSignature,
      previousScanHeadSignature: state.old.scanHeadSignature,
      previousScanBeforeSignature: state.old.scanBeforeSignature,
      previousBackfillComplete: state.old.backfillComplete,
      previousRevision: state.old.revision,
      previousCursorCreatedAt: new Date(state.old.createdAt),
      previousCursorUpdatedAt: new Date(state.old.updatedAt),
      previousCursorSha256: state.oldSha256,
      newCoverageStartSignature: confirmed.newBoundary,
      newBoundarySlot: evidence.slot,
      newBoundaryConfigurationSlot: evidence.configurationSlot,
      newBoundaryEventKey: evidence.eventKey,
      newBoundaryWalletAddress: evidence.walletAddress,
      newBoundaryEnrollmentAddress: evidence.enrollmentAddress,
      reason: confirmed.reason,
    } });
    const updated = await tx.solanaIngestionCursor.updateMany({
      where: {
        id: state.cursor.id,
        ...state.domain,
        coverageStartSignature: state.old.coverageStartSignature,
        committedHeadSignature: null,
        scanHeadSignature: null,
        scanBeforeSignature: null,
        backfillComplete: false,
        revision: state.old.revision,
        createdAt: state.cursor.createdAt,
        updatedAt: state.cursor.updatedAt,
      },
      data: { coverageStartSignature: confirmed.newBoundary, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error("Ingestion cursor compare-and-swap conflict");
    const cursor = await tx.solanaIngestionCursor.findUniqueOrThrow({ where: { id: state.cursor.id } });
    return { rotation, cursor: snapshot(cursor) };
  }, { provider: options.provider });
  return {
    rotationId: result.rotation.id,
    priorCursorSha256: result.rotation.previousCursorSha256,
    newCursor: result.cursor,
    boundaryEvidence: evidence,
    fullHistory: false as const,
  };
}
