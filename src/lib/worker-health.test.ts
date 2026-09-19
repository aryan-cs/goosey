import type { WorkerState } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  classifyWorkerReadiness,
  DEFAULT_WORKER_READINESS_POLICY,
  type WorkerBacklogSnapshot,
} from "./worker-health";

const NOW = new Date("2026-09-19T12:00:00.000Z");

function worker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    id: "settlement",
    workerName: "settlement",
    instanceId: "worker_123",
    status: "RUNNING",
    startedAt: new Date(NOW.getTime() - 60_000),
    lastHeartbeatAt: new Date(NOW.getTime() - 1_000),
    lastCycleStartedAt: new Date(NOW.getTime() - 2_000),
    lastCycleSucceededAt: new Date(NOW.getTime() - 1_000),
    lastCycleFailedAt: null,
    stoppedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    cycleCount: 10n,
    successCount: 10n,
    failureCount: 0n,
    closedMarketCount: 2n,
    completedRunCount: 1n,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: new Date(NOW.getTime() - 1_000),
    ...overrides,
  };
}

function backlog(overrides: Partial<WorkerBacklogSnapshot> = {}): WorkerBacklogSnapshot {
  return {
    expiredMarketCount: 0,
    oldestExpiredMarketAt: null,
    activeSettlementRunCount: 0,
    oldestActiveSettlementRunAt: null,
    expiredLeaseCount: 0,
    oldestExpiredLeaseAt: null,
    ...overrides,
  };
}

describe("worker readiness", () => {
  it("reports a fresh successful worker as ready", () => {
    const result = classifyWorkerReadiness({ now: NOW, worker: worker(), backlog: backlog() });
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails closed when the worker is missing, stopped, stale, or failing", () => {
    expect(classifyWorkerReadiness({ now: NOW, worker: null, backlog: backlog() }).reasons)
      .toContainEqual(expect.objectContaining({ code: "WORKER_MISSING" }));

    const result = classifyWorkerReadiness({
      now: NOW,
      worker: worker({
        status: "STOPPED",
        lastHeartbeatAt: new Date(NOW.getTime() - DEFAULT_WORKER_READINESS_POLICY.staleAfterMs - 1),
        consecutiveFailures: 2,
      }),
      backlog: backlog(),
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "WORKER_NOT_RUNNING",
      "WORKER_STALE",
      "WORKER_FAILING",
    ]);
  });

  it("allows a young backlog but rejects lagged work and expired leases", () => {
    const young = classifyWorkerReadiness({
      now: NOW,
      worker: worker(),
      backlog: backlog({
        expiredMarketCount: 1,
        oldestExpiredMarketAt: new Date(NOW.getTime() - 10_000),
        activeSettlementRunCount: 1,
        oldestActiveSettlementRunAt: new Date(NOW.getTime() - 10_000),
      }),
    });
    expect(young.ready).toBe(true);

    const lagged = classifyWorkerReadiness({
      now: NOW,
      worker: worker(),
      backlog: backlog({
        expiredMarketCount: 1,
        oldestExpiredMarketAt: new Date(NOW.getTime() - 180_000),
        activeSettlementRunCount: 1,
        oldestActiveSettlementRunAt: new Date(NOW.getTime() - 180_000),
        expiredLeaseCount: 1,
        oldestExpiredLeaseAt: new Date(NOW.getTime() - 5_000),
      }),
    });
    expect(lagged.ready).toBe(false);
    expect(lagged.reasons.map((reason) => reason.code)).toEqual([
      "EXPIRED_MARKET_BACKLOG",
      "SETTLEMENT_BACKLOG",
      "EXPIRED_SETTLEMENT_LEASE",
    ]);
  });
});
