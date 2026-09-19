import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";
import { isPrismaErrorCode, prismaErrorCode } from "@/lib/prisma-errors";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { drainMarketOrderBook, expireOrders } from "@/lib/order-exchange";
import { processSettlementRun } from "@/lib/settlement-service";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import {
  DEFAULT_WORKER_READINESS_POLICY,
  readWorkerReadiness,
  SETTLEMENT_WORKER_ID,
  SETTLEMENT_WORKER_NAME,
} from "@/lib/worker-health";

const MARKET_BATCH_SIZE = 100;
const RUN_BATCH_SIZE = 100;
const MAX_PERSISTED_ERROR_LENGTH = 512;

type ProcessRun = typeof processSettlementRun;

export type SettlementWorkerCycleResult = {
  expiredOrders: number;
  orderExpirationFailures: number;
  closedMarkets: number;
  marketCloseFailures: number;
  attemptedRuns: number;
  completedRuns: number;
  busyRuns: number;
  failedRuns: number;
  backlog: {
    expiredMarketCount: number;
    oldestExpiredMarketAt: Date | null;
    activeSettlementRunCount: number;
    oldestActiveSettlementRunAt: Date | null;
    expiredLeaseCount: number;
    oldestExpiredLeaseAt: Date | null;
  };
};

export function sanitizedWorkerError(error: unknown): string {
  let label = "WORKER_OPERATION_FAILED";
  if (error instanceof ApiError) label = error.code;
  else if (prismaErrorCode(error)) label = `PRISMA_${prismaErrorCode(error)}`;
  else if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(error.name)) label = error.name;
  return label.slice(0, MAX_PERSISTED_ERROR_LENGTH);
}

export class SettlementWorkerAlreadyActiveError extends Error {
  constructor() {
    super("Another settlement worker has a fresh ownership heartbeat.");
    this.name = "SettlementWorkerAlreadyActiveError";
  }
}

export async function registerSettlementWorker(
  instanceId: string = randomUUID(),
  client: PrismaClient = db,
  now = new Date(),
): Promise<string> {
  const staleBefore = new Date(now.getTime() - DEFAULT_WORKER_READINESS_POLICY.staleAfterMs);
  const state = {
    instanceId,
    status: "RUNNING",
    startedAt: now,
    lastHeartbeatAt: now,
    stoppedAt: null,
    consecutiveFailures: 0,
    lastError: null,
  } as const;
  const claimed = await client.workerState.updateMany({
    where: {
      id: SETTLEMENT_WORKER_ID,
      OR: [
        { instanceId },
        { status: { not: "RUNNING" } },
        { lastHeartbeatAt: { lte: staleBefore } },
      ],
    },
    data: state,
  });
  if (claimed.count === 1) return instanceId;

  try {
    await client.workerState.create({
      data: {
        id: SETTLEMENT_WORKER_ID,
        workerName: SETTLEMENT_WORKER_NAME,
        ...state,
      },
    });
  } catch (error) {
    if (isPrismaErrorCode(error, "P2002")) {
      throw new SettlementWorkerAlreadyActiveError();
    }
    throw error;
  }
  return instanceId;
}

async function requireWorkerOwnership(client: PrismaClient, instanceId: string, data: Prisma.WorkerStateUpdateManyMutationInput) {
  const updated = await client.workerState.updateMany({
    where: { id: SETTLEMENT_WORKER_ID, instanceId },
    data,
  });
  if (updated.count !== 1) throw new Error("SettlementWorkerOwnershipLost");
}

export async function heartbeatSettlementWorker(
  instanceId: string,
  client: PrismaClient = db,
  now = new Date(),
): Promise<void> {
  await requireWorkerOwnership(client, instanceId, {
    status: "RUNNING",
    lastHeartbeatAt: now,
  });
}

async function systemActorId(client: PrismaClient): Promise<string> {
  const actor = await client.user.findFirst({
    where: { role: "SYSTEM", status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!actor) throw new Error("SettlementSystemPrincipalMissing");
  return actor.id;
}

async function closeExpiredMarkets(input: {
  client: PrismaClient;
  actorUserId: string;
  instanceId: string;
  now: Date;
  shouldStop?: () => boolean;
}): Promise<{ closed: number; failures: string[] }> {
  if (input.shouldStop?.()) return { closed: 0, failures: [] };
  const markets = await input.client.market.findMany({
    where: { status: "OPEN", closesAt: { lte: input.now } },
    orderBy: [{ closesAt: "asc" }, { id: "asc" }],
    take: MARKET_BATCH_SIZE,
    select: { id: true, version: true },
  });
  let closed = 0;
  const failures: string[] = [];
  for (const market of markets) {
    if (input.shouldStop?.()) break;
    try {
      await heartbeatSettlementWorker(input.instanceId, input.client);
      if (input.shouldStop?.()) break;
      const changed = await runSerializableTransaction(input.client, async (tx) => {
        const update = await tx.market.updateMany({
          where: { id: market.id, status: "OPEN", version: market.version, closesAt: { lte: input.now } },
          data: { status: "CLOSED", acceptingOrders: false, version: { increment: 1 } },
        });
        if (update.count !== 1) return false;
        await drainMarketOrderBook(tx, {
          marketId: market.id,
          actorUserId: input.actorUserId,
          reason: "MARKET_CLOSED",
          operationAt: input.now,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            action: "MARKET_AUTO_CLOSED",
            entityType: "MARKET",
            entityId: market.id,
            metadata: JSON.stringify({ reason: "Contractual close time elapsed.", workerAt: input.now.toISOString() }),
          },
        });
        return true;
      });
      if (changed) closed += 1;
    } catch (error) {
      failures.push(`MARKET_CLOSE:${market.id}:${sanitizedWorkerError(error)}`.slice(0, MAX_PERSISTED_ERROR_LENGTH));
    }
  }
  return { closed, failures };
}

async function processAvailableRuns(input: {
  client: PrismaClient;
  actorUserId: string;
  instanceId: string;
  processRun: ProcessRun;
  shouldStop?: () => boolean;
}): Promise<{ attempted: number; completed: number; busy: number; failures: string[] }> {
  if (input.shouldStop?.()) return { attempted: 0, completed: 0, busy: 0, failures: [] };
  const runs = await input.client.marketSettlementRun.findMany({
    where: { status: { in: ["READY", "RUNNING", "FINALIZING"] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: RUN_BATCH_SIZE,
    select: { id: true },
  });
  let completed = 0;
  let attempted = 0;
  let busy = 0;
  const failures: string[] = [];
  for (const run of runs) {
    if (input.shouldStop?.()) break;
    try {
      await heartbeatSettlementWorker(input.instanceId, input.client);
      if (input.shouldStop?.()) break;
      attempted += 1;
      const result = await input.processRun({ actorUserId: input.actorUserId, runId: run.id, batchSize: RUN_BATCH_SIZE });
      if (result.run.status === "COMPLETED") completed += 1;
    } catch (error) {
      if (error instanceof ApiError && error.code === "SETTLEMENT_RUN_BUSY") {
        busy += 1;
      } else {
        failures.push(`SETTLEMENT_RUN:${run.id}:${sanitizedWorkerError(error)}`.slice(0, MAX_PERSISTED_ERROR_LENGTH));
      }
    }
  }
  return { attempted, completed, busy, failures };
}

export async function runSettlementWorkerCycle(input: {
  instanceId: string;
  client?: PrismaClient;
  processRun?: ProcessRun;
  now?: Date;
  shouldStop?: () => boolean;
}): Promise<SettlementWorkerCycleResult> {
  const client = input.client ?? db;
  const processRun = input.processRun ?? processSettlementRun;
  const shouldStop = input.shouldStop ?? (() => false);
  const startedAt = input.now ?? new Date();
  await requireWorkerOwnership(client, input.instanceId, {
    status: "RUNNING",
    lastHeartbeatAt: startedAt,
    lastCycleStartedAt: startedAt,
    cycleCount: { increment: 1n },
  });

  try {
    const actorUserId = shouldStop() ? null : await systemActorId(client);
    const expirations = shouldStop() ? { expired: 0, failures: [] } : await expireOrders(
      client,
      startedAt,
      () => heartbeatSettlementWorker(input.instanceId, client),
      shouldStop,
    );
    const closures = actorUserId === null || shouldStop() ? { closed: 0, failures: [] }
      : await closeExpiredMarkets({ client, actorUserId, instanceId: input.instanceId, now: startedAt, shouldStop });
    const runs = actorUserId === null || shouldStop() ? { attempted: 0, completed: 0, busy: 0, failures: [] }
      : await processAvailableRuns({ client, actorUserId, instanceId: input.instanceId, processRun, shouldStop });
    const expirationFailures = expirations.failures.map(({ orderId, error }) =>
      `ORDER_EXPIRATION:${orderId}:${sanitizedWorkerError(error)}`.slice(0, MAX_PERSISTED_ERROR_LENGTH));
    const failures = [...expirationFailures, ...closures.failures, ...runs.failures];
    const finishedAt = new Date();
    if (failures.length === 0 && shouldStop()) {
      // Preserve prior health history: an interrupted cycle is neither a full
      // success nor a failure. Keep counters for operations that did finish.
      await requireWorkerOwnership(client, input.instanceId, {
        lastHeartbeatAt: finishedAt,
        closedMarketCount: { increment: BigInt(closures.closed) },
        completedRunCount: { increment: BigInt(runs.completed) },
      });
    } else if (failures.length === 0) {
      await requireWorkerOwnership(client, input.instanceId, {
        status: "RUNNING",
        lastHeartbeatAt: finishedAt,
        lastCycleSucceededAt: finishedAt,
        consecutiveFailures: 0,
        lastError: null,
        successCount: { increment: 1n },
        closedMarketCount: { increment: BigInt(closures.closed) },
        completedRunCount: { increment: BigInt(runs.completed) },
      });
    } else {
      await requireWorkerOwnership(client, input.instanceId, {
        status: "RUNNING",
        lastHeartbeatAt: finishedAt,
        lastCycleFailedAt: finishedAt,
        consecutiveFailures: { increment: 1 },
        lastError: failures.join(";").slice(0, MAX_PERSISTED_ERROR_LENGTH),
        failureCount: { increment: 1n },
        closedMarketCount: { increment: BigInt(closures.closed) },
        completedRunCount: { increment: BigInt(runs.completed) },
      });
    }
    const readiness = await readWorkerReadiness(client, { now: finishedAt });
    return {
      expiredOrders: expirations.expired,
      orderExpirationFailures: expirationFailures.length,
      closedMarkets: closures.closed,
      marketCloseFailures: closures.failures.length,
      attemptedRuns: runs.attempted,
      completedRuns: runs.completed,
      busyRuns: runs.busy,
      failedRuns: runs.failures.length,
      backlog: readiness.backlog,
    };
  } catch (error) {
    const failedAt = new Date();
    await requireWorkerOwnership(client, input.instanceId, {
      status: "RUNNING",
      lastHeartbeatAt: failedAt,
      lastCycleFailedAt: failedAt,
      consecutiveFailures: { increment: 1 },
      lastError: sanitizedWorkerError(error),
      failureCount: { increment: 1n },
    }).catch(() => undefined);
    throw error;
  }
}

export async function stopSettlementWorker(
  instanceId: string,
  client: PrismaClient = db,
  now = new Date(),
): Promise<void> {
  await requireWorkerOwnership(client, instanceId, {
    status: "STOPPED",
    stoppedAt: now,
    lastHeartbeatAt: now,
  });
}
