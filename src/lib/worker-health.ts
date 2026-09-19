import type { PrismaClient, WorkerState } from "@prisma/client";

export const SETTLEMENT_WORKER_ID = "settlement";
export const SETTLEMENT_WORKER_NAME = "settlement";

export type WorkerReadinessPolicy = {
  staleAfterMs: number;
  expiredMarketLagMs: number;
  settlementRunLagMs: number;
};

export const DEFAULT_WORKER_READINESS_POLICY: WorkerReadinessPolicy = {
  staleAfterMs: 30_000,
  expiredMarketLagMs: 120_000,
  settlementRunLagMs: 120_000,
};

export type WorkerBacklogSnapshot = {
  expiredMarketCount: number;
  oldestExpiredMarketAt: Date | null;
  activeSettlementRunCount: number;
  oldestActiveSettlementRunAt: Date | null;
  expiredLeaseCount: number;
  oldestExpiredLeaseAt: Date | null;
};

export type WorkerReadinessReason = {
  code: string;
  message: string;
};

export type WorkerReadiness = {
  ready: boolean;
  checkedAt: Date;
  worker: {
    status: string;
    lastHeartbeatAt: Date | null;
    lastCycleSucceededAt: Date | null;
    consecutiveFailures: number;
  } | null;
  backlog: WorkerBacklogSnapshot;
  reasons: WorkerReadinessReason[];
};

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function workerReadinessPolicyFromEnvironment(): WorkerReadinessPolicy {
  return {
    staleAfterMs: positiveEnvironmentInteger("SETTLEMENT_WORKER_STALE_AFTER_MS", DEFAULT_WORKER_READINESS_POLICY.staleAfterMs),
    expiredMarketLagMs: positiveEnvironmentInteger("EXPIRED_MARKET_READY_LAG_MS", DEFAULT_WORKER_READINESS_POLICY.expiredMarketLagMs),
    settlementRunLagMs: positiveEnvironmentInteger("SETTLEMENT_RUN_READY_LAG_MS", DEFAULT_WORKER_READINESS_POLICY.settlementRunLagMs),
  };
}

function ageMs(now: Date, date: Date | null): number | null {
  return date ? Math.max(0, now.getTime() - date.getTime()) : null;
}

export function classifyWorkerReadiness(input: {
  now: Date;
  worker: WorkerState | null;
  backlog: WorkerBacklogSnapshot;
  policy?: WorkerReadinessPolicy;
}): WorkerReadiness {
  const policy = input.policy ?? DEFAULT_WORKER_READINESS_POLICY;
  const reasons: WorkerReadinessReason[] = [];
  const worker = input.worker;

  if (!worker) {
    reasons.push({ code: "WORKER_MISSING", message: "The settlement worker has not registered." });
  } else {
    if (worker.status !== "RUNNING") {
      reasons.push({ code: "WORKER_NOT_RUNNING", message: "The settlement worker is not running." });
    }
    if (ageMs(input.now, worker.lastHeartbeatAt)! > policy.staleAfterMs) {
      reasons.push({ code: "WORKER_STALE", message: "The settlement worker heartbeat is stale." });
    }
    if (worker.consecutiveFailures > 0) {
      reasons.push({ code: "WORKER_FAILING", message: "The settlement worker has an uncleared cycle failure." });
    }
  }

  const expiredMarketAge = ageMs(input.now, input.backlog.oldestExpiredMarketAt);
  if (
    input.backlog.expiredMarketCount > 0 &&
    expiredMarketAge !== null &&
    expiredMarketAge > policy.expiredMarketLagMs
  ) {
    reasons.push({ code: "EXPIRED_MARKET_BACKLOG", message: "Expired markets have exceeded the automatic-close lag budget." });
  }

  const settlementRunAge = ageMs(input.now, input.backlog.oldestActiveSettlementRunAt);
  if (
    input.backlog.activeSettlementRunCount > 0 &&
    settlementRunAge !== null &&
    settlementRunAge > policy.settlementRunLagMs
  ) {
    reasons.push({ code: "SETTLEMENT_BACKLOG", message: "Approved settlement runs have exceeded the processing lag budget." });
  }
  if (input.backlog.expiredLeaseCount > 0) {
    reasons.push({ code: "EXPIRED_SETTLEMENT_LEASE", message: "A settlement run has an expired worker lease." });
  }

  return {
    ready: reasons.length === 0,
    checkedAt: input.now,
    worker: worker
      ? {
          status: worker.status,
          lastHeartbeatAt: worker.lastHeartbeatAt,
          lastCycleSucceededAt: worker.lastCycleSucceededAt,
          consecutiveFailures: worker.consecutiveFailures,
        }
      : null,
    backlog: input.backlog,
    reasons,
  };
}

type ReadinessClient = Pick<PrismaClient, "workerState" | "market" | "marketSettlementRun">;

export async function readWorkerReadiness(
  client: ReadinessClient,
  options: { now?: Date; policy?: WorkerReadinessPolicy } = {},
): Promise<WorkerReadiness> {
  const now = options.now ?? new Date();
  const [worker, expiredMarketCount, oldestExpiredMarket, activeSettlementRunCount, oldestActiveRun, expiredLeaseCount, oldestExpiredLease] =
    await Promise.all([
      client.workerState.findUnique({ where: { id: SETTLEMENT_WORKER_ID } }),
      client.market.count({ where: { status: "OPEN", closesAt: { lte: now } } }),
      client.market.findFirst({
        where: { status: "OPEN", closesAt: { lte: now } },
        orderBy: { closesAt: "asc" },
        select: { closesAt: true },
      }),
      client.marketSettlementRun.count({ where: { status: { in: ["READY", "RUNNING", "FINALIZING"] } } }),
      client.marketSettlementRun.findFirst({
        where: { status: { in: ["READY", "RUNNING", "FINALIZING"] } },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      client.marketSettlementRun.count({
        where: { status: { in: ["RUNNING", "FINALIZING"] }, leaseExpiresAt: { lte: now } },
      }),
      client.marketSettlementRun.findFirst({
        where: { status: { in: ["RUNNING", "FINALIZING"] }, leaseExpiresAt: { lte: now } },
        orderBy: { leaseExpiresAt: "asc" },
        select: { leaseExpiresAt: true },
      }),
    ]);

  return classifyWorkerReadiness({
    now,
    worker,
    backlog: {
      expiredMarketCount,
      oldestExpiredMarketAt: oldestExpiredMarket?.closesAt ?? null,
      activeSettlementRunCount,
      oldestActiveSettlementRunAt: oldestActiveRun?.createdAt ?? null,
      expiredLeaseCount,
      oldestExpiredLeaseAt: oldestExpiredLease?.leaseExpiresAt ?? null,
    },
    policy: options.policy ?? workerReadinessPolicyFromEnvironment(),
  });
}
