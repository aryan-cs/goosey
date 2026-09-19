import { createHash, randomUUID } from "node:crypto";

import { type Prisma, type PrismaClient, type WorkerState } from "@prisma/client";

import { isPrismaErrorCode, prismaErrorCode } from "@/lib/prisma-errors";
import type { SolanaRuntime } from "@/lib/solana/runtime";

export const SOLANA_INDEXER_STALE_AFTER_MS = 180_000;
const MAX_PERSISTED_ERROR_TYPE_LENGTH = 96;

type Deployment = Pick<SolanaRuntime, "genesisHash" | "programAddress">;
type IndexerHealthClient = Pick<PrismaClient, "workerState" | "solanaIngestionCursor">;

export type SolanaIndexerLease = Readonly<{
  workerId: string;
  workerName: string;
  instanceId: string;
}>;

export class SolanaIndexerAlreadyActiveError extends Error {
  constructor() {
    super("Another continuous Solana indexer has a fresh ownership heartbeat.");
    this.name = "SolanaIndexerAlreadyActiveError";
  }
}

export class SolanaIndexerOwnershipLostError extends Error {
  constructor() {
    super("Continuous Solana indexer ownership was lost.");
    this.name = "SolanaIndexerOwnershipLostError";
  }
}

/** The RPC URL is deliberately excluded. Rotating credentials or providers must
 * not create another lease for the same deployed program, and no URL material
 * may be persisted in WorkerState or returned by the public status endpoint. */
export function solanaIndexerWorkerIdentity(deployment: Deployment) {
  const digest = createHash("sha256")
    .update("goosey-solana-indexer-v1\0")
    .update(deployment.genesisHash)
    .update("\0")
    .update(deployment.programAddress.toString())
    .digest("hex")
    .slice(0, 32);
  const value = `solana-indexer-${digest}`;
  return { workerId: value, workerName: value } as const;
}

export function sanitizedIndexerErrorType(error: unknown): string {
  const prismaCode = prismaErrorCode(error);
  if (prismaCode) return `PRISMA_${prismaCode}`;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(error.name)) {
    return error.name.slice(0, MAX_PERSISTED_ERROR_TYPE_LENGTH);
  }
  return "INDEXER_CYCLE_FAILED";
}

/** Matches only an abort that originated from this exact signal. Merely having
 * the name AbortError is insufficient: providers may use that name for their
 * own failures, and the per-cycle timeout uses a separate signal/reason. */
export function isAbortFromSignal(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted || !error || typeof error !== "object" || !("name" in error)
    || error.name !== "AbortError") return false;
  return error === signal.reason || ("cause" in error && error.cause === signal.reason);
}

function leaseWhere(lease: SolanaIndexerLease) {
  return {
    id: lease.workerId,
    workerName: lease.workerName,
    instanceId: lease.instanceId,
    status: "RUNNING",
  } as const;
}

async function requireOwnership(
  client: IndexerHealthClient,
  lease: SolanaIndexerLease,
  data: Prisma.WorkerStateUpdateManyMutationInput,
) {
  const updated = await client.workerState.updateMany({ where: leaseWhere(lease), data });
  if (updated.count !== 1) throw new SolanaIndexerOwnershipLostError();
}

export async function registerContinuousSolanaIndexer(
  deployment: Deployment,
  options: {
    client?: IndexerHealthClient;
    instanceId?: string;
    now?: Date;
    staleAfterMs?: number;
  } = {},
): Promise<SolanaIndexerLease> {
  const client = options.client ?? await defaultClient();
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? SOLANA_INDEXER_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 300_000) {
    throw new Error("Invalid Solana indexer stale-heartbeat policy");
  }
  const identity = solanaIndexerWorkerIdentity(deployment);
  const lease = { ...identity, instanceId: options.instanceId ?? randomUUID() };
  const state = {
    instanceId: lease.instanceId,
    status: "RUNNING",
    startedAt: now,
    lastHeartbeatAt: now,
    stoppedAt: null,
    consecutiveFailures: 0,
    lastError: null,
  } as const;
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  const claimed = await client.workerState.updateMany({
    where: {
      id: lease.workerId,
      workerName: lease.workerName,
      OR: [
        { instanceId: lease.instanceId },
        { status: { not: "RUNNING" } },
        { lastHeartbeatAt: { lte: staleBefore } },
      ],
    },
    data: state,
  });
  if (claimed.count === 1) return lease;

  try {
    await client.workerState.create({
      data: {
        id: lease.workerId,
        workerName: lease.workerName,
        ...state,
      },
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) throw new SolanaIndexerAlreadyActiveError();
    throw error;
  }
  return lease;
}

export async function heartbeatContinuousSolanaIndexer(
  lease: SolanaIndexerLease,
  client?: IndexerHealthClient,
  now = new Date(),
) {
  await requireOwnership(client ?? await defaultClient(), lease, { lastHeartbeatAt: now });
}

export async function beginContinuousSolanaIndexerCycle(
  lease: SolanaIndexerLease,
  client?: IndexerHealthClient,
  now = new Date(),
) {
  await requireOwnership(client ?? await defaultClient(), lease, {
    lastHeartbeatAt: now,
    lastCycleStartedAt: now,
    cycleCount: { increment: 1n },
  });
}

export async function succeedContinuousSolanaIndexerCycle(
  lease: SolanaIndexerLease,
  client?: IndexerHealthClient,
  now = new Date(),
) {
  await requireOwnership(client ?? await defaultClient(), lease, {
    lastHeartbeatAt: now,
    lastCycleSucceededAt: now,
    consecutiveFailures: 0,
    lastError: null,
    successCount: { increment: 1n },
  });
}

export async function failContinuousSolanaIndexerCycle(
  lease: SolanaIndexerLease,
  error: unknown,
  client?: IndexerHealthClient,
  now = new Date(),
) {
  await requireOwnership(client ?? await defaultClient(), lease, {
    lastHeartbeatAt: now,
    lastCycleFailedAt: now,
    consecutiveFailures: { increment: 1 },
    lastError: sanitizedIndexerErrorType(error),
    failureCount: { increment: 1n },
  });
}

/** A cycle cannot run until the lease heartbeat/counter CAS succeeds. The
 * completion CAS is equally mandatory: if another instance took ownership,
 * this process fails closed even if its cursor transaction already committed.
 * Cursor continuity/CAS remains the authority for replay without history gaps. */
export async function runOwnedContinuousSolanaIndexerCycle<T>(
  lease: SolanaIndexerLease,
  operation: () => Promise<T>,
  options: { client?: IndexerHealthClient; now?: () => Date; gracefulStopSignal?: AbortSignal } = {},
): Promise<T> {
  const client = options.client ?? await defaultClient();
  const now = options.now ?? (() => new Date());
  await beginContinuousSolanaIndexerCycle(lease, client, now());
  try {
    const result = await operation();
    await succeedContinuousSolanaIndexerCycle(lease, client, now());
    return result;
  } catch (error) {
    if (error instanceof SolanaIndexerOwnershipLostError) throw error;
    try {
      if (options.gracefulStopSignal && isAbortFromSignal(error, options.gracefulStopSignal)) {
        // An operator stop interrupts, rather than fails, the cycle. Still CAS
        // the lease after the operation so ownership loss cannot be hidden.
        await heartbeatContinuousSolanaIndexer(lease, client, now());
      } else {
        await failContinuousSolanaIndexerCycle(lease, error, client, now());
      }
    } catch (healthError) {
      // Ownership loss is more important than the provider failure: the old
      // process must terminate and must not continue on another cycle.
      throw healthError;
    }
    throw error;
  }
}

export async function stopContinuousSolanaIndexer(
  lease: SolanaIndexerLease,
  client?: IndexerHealthClient,
  now = new Date(),
) {
  await requireOwnership(client ?? await defaultClient(), lease, {
    status: "STOPPED",
    stoppedAt: now,
    lastHeartbeatAt: now,
  });
}

type PublicWorkerState = "missing" | "stopped" | "stale" | "failing" | "running";

function publicWorker(worker: WorkerState | null, now: Date, staleAfterMs: number) {
  let state: PublicWorkerState;
  if (!worker) state = "missing";
  else if (worker.status === "RUNNING" && now.getTime() - worker.lastHeartbeatAt.getTime() >= staleAfterMs) state = "stale";
  else if (worker.consecutiveFailures > 0) state = "failing";
  else if (worker.status !== "RUNNING") state = "stopped";
  else state = "running";
  return worker ? {
    state,
    updatedAt: worker.updatedAt.toISOString(),
    cycleCount: worker.cycleCount.toString(),
    successCount: worker.successCount.toString(),
    failureCount: worker.failureCount.toString(),
    consecutiveFailures: worker.consecutiveFailures,
  } : {
    state,
    updatedAt: null,
    cycleCount: "0",
    successCount: "0",
    failureCount: "0",
    consecutiveFailures: 0,
  };
}

export async function readPublicSolanaIndexerStatus(
  deployment: Deployment,
  options: { client?: IndexerHealthClient; now?: Date; staleAfterMs?: number } = {},
) {
  const client = options.client ?? await defaultClient();
  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? SOLANA_INDEXER_STALE_AFTER_MS;
  const identity = solanaIndexerWorkerIdentity(deployment);
  const domain = { genesisHash: deployment.genesisHash, programAddress: deployment.programAddress.toString() };
  const [worker, cursor] = await Promise.all([
    client.workerState.findUnique({ where: { id: identity.workerId } }),
    client.solanaIngestionCursor.findUnique({
      where: { genesisHash_programAddress: domain },
      select: {
        committedHeadSignature: true,
        scanHeadSignature: true,
        scanBeforeSignature: true,
        backfillComplete: true,
        revision: true,
        updatedAt: true,
      },
    }),
  ]);
  if (worker && worker.workerName !== identity.workerName) throw new Error("Inconsistent stored indexer identity");
  if (cursor && (
    cursor.backfillComplete !== (cursor.committedHeadSignature !== null)
    || (cursor.scanHeadSignature === null) !== (cursor.scanBeforeSignature === null)
    || !Number.isInteger(cursor.revision) || cursor.revision < 0
  )) throw new Error("Inconsistent stored ingestion coverage");

  return {
    worker: publicWorker(worker, now, staleAfterMs),
    coverage: cursor ? {
      status: cursor.backfillComplete ? "bounded_complete" as const : "partial" as const,
      revision: cursor.revision,
      updatedAt: cursor.updatedAt.toISOString(),
      fullHistory: false as const,
    } : {
      status: "unavailable" as const,
      revision: null,
      updatedAt: null,
      fullHistory: false as const,
    },
  };
}

async function defaultClient(): Promise<IndexerHealthClient> {
  const { db, requireDatabaseStartup } = await import("@/lib/db");
  await requireDatabaseStartup();
  return db;
}
