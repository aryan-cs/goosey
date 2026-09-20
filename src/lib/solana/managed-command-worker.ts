import type { PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import type { TransactionRunner } from "@/lib/serializable-transaction";
import type { ChainCommandStatus } from "@/lib/solana/chain-command";
import { ChainCommandConflictError } from "@/lib/solana/chain-command-state";
import type { PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { dispatchManagedCancellationCommand } from "@/lib/solana/managed-cancellation-dispatcher";
import { dispatchManagedEscrowDepositCommand } from "@/lib/solana/managed-escrow-dispatcher";
import { dispatchManagedMarketProvisioningCommand } from "@/lib/solana/managed-market-provisioning-dispatcher";
import { dispatchManagedMarketBookCommand } from "@/lib/solana/managed-market-book-dispatcher";
import { dispatchManagedOrderCommand } from "@/lib/solana/managed-order-dispatcher";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { dispatchManagedSeatRegistrationCommand } from "@/lib/solana/managed-seat-dispatcher";
import { dispatchManagedFeatherTransferCommand } from "@/lib/solana/managed-transfer-dispatcher";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const MANAGED_COMMAND_OPERATIONS = [
  "PROVISION_MARKET",
  "PROVISION_MARKET_BOOK",
  "REGISTER_SEAT",
  "DEPOSIT_ESCROW",
  "PLACE_ORDER",
  "CANCEL_ORDER",
  "TRANSFER_FEATHERS",
  "CLOSE_RESOLUTION",
  "PROPOSE_RESOLUTION",
  "APPROVE_RESOLUTION",
  "CLAIM_RESOLUTION",
  "FINALIZE_RESOLUTION",
] as const;
export type ManagedCommandOperation = (typeof MANAGED_COMMAND_OPERATIONS)[number];

const MANAGED_RESOLUTION_OPERATIONS = new Set<ManagedCommandOperation>([
  "CLOSE_RESOLUTION",
  "PROPOSE_RESOLUTION",
  "APPROVE_RESOLUTION",
  "CLAIM_RESOLUTION",
  "FINALIZE_RESOLUTION",
]);

const DISPATCHABLE_STATUSES = [
  "ACCEPTED",
  "PREPARED",
  "SIGNED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED_RETRYABLE",
] as const satisfies readonly ChainCommandStatus[];
const NON_RETRYABLE_STARTS = DISPATCHABLE_STATUSES.filter(status => status !== "FAILED_RETRYABLE");

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_RETRY_COOLDOWN_MS = 5_000;
const DEFAULT_PER_OPERATION_BATCH_SIZE = 25;

type Candidate = Readonly<{
  id: string;
  operation: string;
  status: string;
  leaseExpiresAt: Date | null;
}>;

type CommandQueue = Pick<PrismaClient["chainCommand"], "findMany">;
type Dispatch = (
  commandId: string,
  dependencies: Readonly<{
    database?: TransactionRunner;
    env?: Record<string, string | undefined>;
    owner?: string;
  }>,
) => Promise<PublicChainCommandStatus>;

export type ManagedCommandWorkerCycleResult = Readonly<{
  selected: number;
  attempted: number;
  completed: number;
  pending: number;
  uncertain: number;
  terminalFailures: number;
  contended: number;
  failed: number;
  stoppedEarly: boolean;
}>;

export type ManagedCommandWorkerConfig = Readonly<{
  pollIntervalMs: number;
  maxBackoffMs: number;
  retryCooldownMs: number;
  perOperationBatchSize: number;
}>;

type CycleDependencies = Readonly<{
  database?: TransactionRunner;
  queue?: CommandQueue;
  env?: Record<string, string | undefined>;
  owner?: string;
  now?: () => Date;
  shouldStop?: () => boolean;
  perOperationBatchSize?: number;
  retryCooldownMs?: number;
  dispatchMarket?: Dispatch;
  dispatchBook?: Dispatch;
  dispatchSeat?: Dispatch;
  dispatchEscrow?: Dispatch;
  dispatchOrder?: Dispatch;
  dispatchCancellation?: Dispatch;
  dispatchTransfer?: Dispatch;
  dispatchResolution?: Dispatch;
}>;

type LoopDependencies = CycleDependencies & Readonly<{
  signal: AbortSignal;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onCycle?: (result: ManagedCommandWorkerCycleResult) => void;
  onCycleError?: (event: Readonly<{ errorType: string; consecutiveFailures: number; retryInMs: number }>) => void;
}>;

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function environmentInteger(
  value: string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === "") return fallback;
  return boundedInteger(Number(value), label, minimum, maximum);
}

export function managedCommandWorkerConfigFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): ManagedCommandWorkerConfig {
  const pollIntervalMs = environmentInteger(env.GOOSEY_CHAIN_WORKER_POLL_MS, DEFAULT_POLL_INTERVAL_MS,
    "GOOSEY_CHAIN_WORKER_POLL_MS", 250, 60_000);
  return Object.freeze({
    pollIntervalMs,
    maxBackoffMs: environmentInteger(env.GOOSEY_CHAIN_WORKER_MAX_BACKOFF_MS,
      DEFAULT_MAX_BACKOFF_MS, "GOOSEY_CHAIN_WORKER_MAX_BACKOFF_MS", pollIntervalMs, 300_000),
    retryCooldownMs: environmentInteger(env.GOOSEY_CHAIN_WORKER_RETRY_COOLDOWN_MS,
      DEFAULT_RETRY_COOLDOWN_MS, "GOOSEY_CHAIN_WORKER_RETRY_COOLDOWN_MS", 1_000, 300_000),
    perOperationBatchSize: environmentInteger(env.GOOSEY_CHAIN_WORKER_BATCH_SIZE,
      DEFAULT_PER_OPERATION_BATCH_SIZE, "GOOSEY_CHAIN_WORKER_BATCH_SIZE", 1, 100),
  });
}

function dispatchForOperation(operation: ManagedCommandOperation, dependencies: CycleDependencies): Dispatch {
  if (operation === "PROVISION_MARKET") return dependencies.dispatchMarket ?? dispatchManagedMarketProvisioningCommand;
  if (operation === "PROVISION_MARKET_BOOK") return dependencies.dispatchBook ?? dispatchManagedMarketBookCommand;
  if (operation === "REGISTER_SEAT") return dependencies.dispatchSeat ?? dispatchManagedSeatRegistrationCommand;
  if (operation === "DEPOSIT_ESCROW") return dependencies.dispatchEscrow ?? dispatchManagedEscrowDepositCommand;
  if (operation === "PLACE_ORDER") return dependencies.dispatchOrder ?? dispatchManagedOrderCommand;
  if (operation === "CANCEL_ORDER") return dependencies.dispatchCancellation ?? dispatchManagedCancellationCommand;
  if (MANAGED_RESOLUTION_OPERATIONS.has(operation)) {
    return dependencies.dispatchResolution ?? dispatchManagedResolutionCommand;
  }
  return dependencies.dispatchTransfer ?? dispatchManagedFeatherTransferCommand;
}

function classifiedStatus(result: PublicChainCommandStatus): Pick<ManagedCommandWorkerCycleResult,
  "completed" | "pending" | "uncertain" | "terminalFailures"> {
  if (result.status === "FINALIZED" || result.status === "PROJECTED") {
    return { completed: 1, pending: 0, uncertain: 0, terminalFailures: 0 };
  }
  if (result.status === "UNKNOWN") {
    return { completed: 0, pending: 0, uncertain: 1, terminalFailures: 0 };
  }
  if (result.status === "FAILED_TERMINAL") {
    return { completed: 0, pending: 0, uncertain: 0, terminalFailures: 1 };
  }
  return { completed: 0, pending: 1, uncertain: 0, terminalFailures: 0 };
}

/**
 * Processes a bounded, dependency-first snapshot of durable commands. Market
 * provisioning precedes participant seat, escrow, and order commands. Selection is
 * advisory: each dispatcher must still win its own revision/lease CAS before
 * it can prepare, journal, or submit a transaction.
 */
export async function runManagedCommandWorkerCycle(
  dependencies: CycleDependencies = {},
): Promise<ManagedCommandWorkerCycleResult> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const retryCooldownMs = boundedInteger(dependencies.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS,
    "retryCooldownMs", 1_000, 300_000);
  const perOperationBatchSize = boundedInteger(
    dependencies.perOperationBatchSize ?? DEFAULT_PER_OPERATION_BATCH_SIZE,
    "perOperationBatchSize", 1, 100,
  );
  const retryBefore = new Date(startedAt.getTime() - retryCooldownMs);
  const queue = dependencies.queue ?? (db.chainCommand as CommandQueue);
  const database = dependencies.database ?? db;
  const shouldStop = dependencies.shouldStop ?? (() => false);
  const owner = dependencies.owner ?? "managed-command-worker";
  const candidates: Candidate[] = [];

  for (const operation of MANAGED_COMMAND_OPERATIONS) {
    if (shouldStop()) break;
    const immediatelyDispatchable = operation === "PROVISION_MARKET" || operation === "PROVISION_MARKET_BOOK"
      ? [...NON_RETRYABLE_STARTS, "UNKNOWN", "FINALIZED"]
      : MANAGED_RESOLUTION_OPERATIONS.has(operation) ? [...NON_RETRYABLE_STARTS, "UNKNOWN"] : NON_RETRYABLE_STARTS;
    const rows = await queue.findMany({
      where: {
        cluster: runtime.cluster,
        genesisHash: runtime.genesisHash,
        programAddress: runtime.programAddress,
        operation,
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: startedAt } }] },
          { OR: [
            { status: { in: immediatelyDispatchable } },
            { status: "FAILED_RETRYABLE", updatedAt: { lte: retryBefore } },
          ] },
        ],
      },
      orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
      take: perOperationBatchSize,
      select: { id: true, operation: true, status: true, leaseExpiresAt: true },
    }) as Candidate[];
    candidates.push(...rows);
  }

  let attempted = 0;
  let completed = 0;
  let pending = 0;
  let uncertain = 0;
  let terminalFailures = 0;
  let contended = 0;
  let failed = 0;
  let stoppedEarly = false;

  for (const candidate of candidates) {
    if (shouldStop()) {
      stoppedEarly = true;
      break;
    }
    if (!MANAGED_COMMAND_OPERATIONS.includes(candidate.operation as ManagedCommandOperation)) continue;
    attempted += 1;
    try {
      const result = await dispatchForOperation(candidate.operation as ManagedCommandOperation, dependencies)(
        candidate.id,
        { database, env, owner },
      );
      const counts = classifiedStatus(result);
      completed += counts.completed;
      pending += counts.pending;
      uncertain += counts.uncertain;
      terminalFailures += counts.terminalFailures;
    } catch (error) {
      if (error instanceof ChainCommandConflictError) contended += 1;
      else failed += 1;
    }
  }

  return Object.freeze({
    selected: candidates.length,
    attempted,
    completed,
    pending,
    uncertain,
    terminalFailures,
    contended,
    failed,
    stoppedEarly,
  });
}

function safeErrorType(error: unknown): string {
  const name = error instanceof Error ? error.name : "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name) ? name : "WorkerCycleError";
}

function interruptibleDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs non-overlapping cycles until aborted. Shutdown stops new claims and
 * waits for any current dispatcher to finish its fenced operation.
 */
export async function runManagedCommandWorker(dependencies: LoopDependencies): Promise<void> {
  const config = managedCommandWorkerConfigFromEnvironment(dependencies.env);
  const pollIntervalMs = boundedInteger(dependencies.pollIntervalMs ?? config.pollIntervalMs,
    "pollIntervalMs", 250, 60_000);
  const maxBackoffMs = boundedInteger(dependencies.maxBackoffMs ?? config.maxBackoffMs,
    "maxBackoffMs", pollIntervalMs, 300_000);
  const sleep = dependencies.sleep ?? interruptibleDelay;
  const random = dependencies.random ?? Math.random;
  if (typeof random !== "function") throw new TypeError("random must be a function");
  let consecutiveFailures = 0;

  while (!dependencies.signal.aborted) {
    try {
      const result = await runManagedCommandWorkerCycle({
        ...dependencies,
        shouldStop: () => dependencies.signal.aborted || dependencies.shouldStop?.() === true,
        perOperationBatchSize: dependencies.perOperationBatchSize ?? config.perOperationBatchSize,
        retryCooldownMs: dependencies.retryCooldownMs ?? config.retryCooldownMs,
      });
      consecutiveFailures = 0;
      dependencies.onCycle?.(result);
    } catch (error) {
      consecutiveFailures += 1;
      const exponential = Math.min(maxBackoffMs, pollIntervalMs * 2 ** Math.min(consecutiveFailures, 16));
      const retryInMs = Math.min(maxBackoffMs,
        Math.max(pollIntervalMs, Math.round(exponential * (0.75 + random() * 0.5))));
      dependencies.onCycleError?.({ errorType: safeErrorType(error), consecutiveFailures, retryInMs });
      if (!dependencies.signal.aborted) await sleep(retryInMs, dependencies.signal);
      continue;
    }

    if (!dependencies.signal.aborted) await sleep(pollIntervalMs, dependencies.signal);
  }
}
