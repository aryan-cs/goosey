import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const { drain, expire } = vi.hoisted(() => ({ drain: vi.fn(), expire: vi.fn() }));

vi.mock("@/lib/order-exchange", () => ({ drainMarketOrderBook: drain, expireOrders: expire }));

import {
  registerSettlementWorker,
  runSettlementWorkerCycle,
  sanitizedWorkerError,
} from "./settlement-worker-service";

describe("settlement worker ownership", () => {
  const now = new Date("2026-09-19T12:00:00.000Z");

  it("registers a new singleton when no state exists", async () => {
    const client = {
      workerState: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockResolvedValue({}),
      },
    };
    await expect(registerSettlementWorker("worker_new", client as never, now)).resolves.toBe("worker_new");
    expect(client.workerState.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: "settlement",
      workerName: "settlement",
      instanceId: "worker_new",
      status: "RUNNING",
    }) });
  });

  it("claims only its own, stopped, or stale worker state", async () => {
    const client = {
      workerState: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn(),
      },
    };
    await registerSettlementWorker("worker_takeover", client as never, now);
    expect(client.workerState.updateMany).toHaveBeenCalledWith({
      where: {
        id: "settlement",
        OR: [
          { instanceId: "worker_takeover" },
          { status: { not: "RUNNING" } },
          { lastHeartbeatAt: { lte: new Date("2026-09-19T11:59:30.000Z") } },
        ],
      },
      data: expect.objectContaining({ instanceId: "worker_takeover", lastHeartbeatAt: now }),
    });
    expect(client.workerState.create).not.toHaveBeenCalled();
  });

  it("rejects a second worker while the current ownership heartbeat is fresh", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const client = {
      workerState: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn().mockRejectedValue(conflict),
      },
    };
    await expect(registerSettlementWorker("worker_second", client as never, now))
      .rejects.toMatchObject({ name: "SettlementWorkerAlreadyActiveError" });
  });
});

function clientFixture() {
  const workerState = {
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findUnique: vi.fn().mockResolvedValue({
      id: "settlement",
      workerName: "settlement",
      instanceId: "worker_123",
      status: "RUNNING",
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastCycleStartedAt: null,
      lastCycleSucceededAt: new Date(),
      lastCycleFailedAt: null,
      stoppedAt: null,
      consecutiveFailures: 0,
      lastError: null,
      cycleCount: 1n,
      successCount: 1n,
      failureCount: 0n,
      closedMarketCount: 0n,
      completedRunCount: 0n,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  };
  const market = {
    findMany: vi.fn().mockResolvedValue([
      { id: "broken_market", version: 1 },
      { id: "healthy_market", version: 2 },
    ]),
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
  };
  const marketSettlementRun = {
    findMany: vi.fn().mockResolvedValue([{ id: "approved_run" }]),
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
  };
  const healthyTx = {
    market: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const transaction = vi.fn()
    .mockRejectedValueOnce(new Error("password=hunter2 database=/private/secret.db"))
    .mockImplementation(async (callback: (tx: unknown) => unknown) => callback(healthyTx));
  return {
    client: {
      workerState,
      user: { findFirst: vi.fn().mockResolvedValue({ id: "system_user" }) },
      market,
      marketSettlementRun,
      $transaction: transaction,
    },
    workerState,
    healthyTx,
  };
}

describe("settlement worker cycle", () => {
  beforeEach(() => {
    drain.mockReset().mockResolvedValue({ canceledOrders: 0, canceledQuantity: 0 });
    expire.mockReset().mockResolvedValue({ expired: 0, failures: [] });
  });

  it("isolates one failed market and still closes later markets and processes approved runs", async () => {
    const fixture = clientFixture();
    const processRun = vi.fn().mockResolvedValue({ run: { status: "COMPLETED" } });

    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123",
      client: fixture.client as never,
      processRun: processRun as never,
      now: new Date("2026-09-19T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      expiredOrders: 0,
      orderExpirationFailures: 0,
      closedMarkets: 1,
      marketCloseFailures: 1,
      attemptedRuns: 1,
      completedRuns: 1,
      failedRuns: 0,
    });
    expect(drain).toHaveBeenCalledOnce();
    expect(fixture.client.market.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ executionBackend: "DATABASE", collateralAccountId: { not: null } }),
    }));
    expect(fixture.healthyTx.market.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ executionBackend: "DATABASE", collateralAccountId: { not: null } }),
    }));
    expect(fixture.client.marketSettlementRun.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ market: { executionBackend: "DATABASE", collateralAccountId: { not: null } } }),
    }));
    expect(processRun).toHaveBeenCalledWith({ actorUserId: "system_user", runId: "approved_run", batchSize: 100 });
    const failureUpdate = fixture.workerState.updateMany.mock.calls.find(([call]) => call.data.lastCycleFailedAt);
    expect(failureUpdate?.[0].data.lastError).toContain("MARKET_CLOSE:broken_market:Error");
    expect(failureUpdate?.[0].data.lastError).not.toContain("hunter2");
    expect(failureUpdate?.[0].data.lastError.length).toBeLessThanOrEqual(512);
  });

  it("records isolated order-expiration failures and continues the cycle", async () => {
    const fixture = clientFixture();
    fixture.client.market.findMany.mockResolvedValue([]);
    fixture.client.marketSettlementRun.findMany.mockResolvedValue([]);
    expire.mockResolvedValue({
      expired: 2,
      failures: [{ orderId: "order_failed", error: new Error("secret=do-not-persist") }],
    });

    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123",
      client: fixture.client as never,
      now: new Date("2026-09-19T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ expiredOrders: 2, orderExpirationFailures: 1 });
    const failureUpdate = fixture.workerState.updateMany.mock.calls.find(([call]) => call.data.lastCycleFailedAt);
    expect(failureUpdate?.[0].data.lastError).toContain("ORDER_EXPIRATION:order_failed:Error");
    expect(failureUpdate?.[0].data.lastError).not.toContain("do-not-persist");
  });

  it("records a fatal cycle failure without persisting its message", async () => {
    const fixture = clientFixture();
    fixture.client.user.findFirst.mockRejectedValue(new Error("token=super-secret-value"));

    await expect(runSettlementWorkerCycle({
      instanceId: "worker_123",
      client: fixture.client as never,
    })).rejects.toThrow("super-secret-value");

    const failureUpdate = fixture.workerState.updateMany.mock.calls.find(([call]) => call.data.failureCount);
    expect(failureUpdate?.[0].data.lastError).toBe("Error");
  });

  it("clears prior failure state after a later successful cycle", async () => {
    const fixture = clientFixture();
    fixture.client.market.findMany.mockResolvedValue([]);
    fixture.client.marketSettlementRun.findMany.mockResolvedValue([]);

    await runSettlementWorkerCycle({
      instanceId: "worker_123",
      client: fixture.client as never,
      now: new Date("2026-09-19T12:00:00.000Z"),
    });

    expect(fixture.workerState.updateMany).toHaveBeenCalledWith({
      where: { id: "settlement", instanceId: "worker_123" },
      data: expect.objectContaining({
        consecutiveFailures: 0,
        lastError: null,
        successCount: { increment: 1n },
      }),
    });
  });

  it("sanitizes unknown failures to a bounded type label", () => {
    expect(sanitizedWorkerError(new Error("authorization=Bearer secret"))).toBe("Error");
  });

  it("skips work when already stopping without recording a failed or successful cycle", async () => {
    const fixture = clientFixture();
    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123", client: fixture.client as never, shouldStop: () => true,
    });
    expect(expire).not.toHaveBeenCalled();
    expect(fixture.client.user.findFirst).not.toHaveBeenCalled();
    expect(fixture.client.market.findMany).not.toHaveBeenCalled();
    expect(fixture.client.marketSettlementRun.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attemptedRuns: 0, failedRuns: 0, marketCloseFailures: 0, orderExpirationFailures: 0 });
    expect(fixture.workerState.updateMany.mock.calls.some(([call]) => call.data.failureCount || call.data.successCount)).toBe(false);
  });

  it("passes the stop predicate to expiration and skips closures and runs after expiration stops", async () => {
    const fixture = clientFixture();
    let stopping = false;
    const shouldStop = () => stopping;
    expire.mockImplementation(async (_client, _at, _heartbeat, stop) => {
      expect(stop).toBe(shouldStop);
      stopping = true;
      return { expired: 1, failures: [] };
    });
    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123", client: fixture.client as never, shouldStop,
    });
    expect(result).toMatchObject({ expiredOrders: 1, orderExpirationFailures: 0, closedMarkets: 0, attemptedRuns: 0 });
    expect(fixture.client.market.findMany).not.toHaveBeenCalled();
    expect(fixture.client.marketSettlementRun.findMany).not.toHaveBeenCalled();
  });

  it("finishes the current market close, but starts neither the next market nor settlement runs", async () => {
    const fixture = clientFixture();
    let stopping = false;
    fixture.client.$transaction.mockReset().mockImplementation(async (callback) => callback(fixture.healthyTx));
    drain.mockImplementation(async () => { stopping = true; return { canceledOrders: 1, canceledQuantity: 2 }; });
    const processRun = vi.fn();
    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123", client: fixture.client as never, processRun: processRun as never, shouldStop: () => stopping,
    });
    expect(fixture.client.$transaction).toHaveBeenCalledOnce();
    expect(drain).toHaveBeenCalledOnce();
    expect(fixture.healthyTx.auditLog.create).toHaveBeenCalledOnce();
    expect(processRun).not.toHaveBeenCalled();
    expect(fixture.client.marketSettlementRun.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ closedMarkets: 1, marketCloseFailures: 0, attemptedRuns: 0, failedRuns: 0 });
    expect(fixture.workerState.updateMany.mock.calls.some(([call]) => call.data.failureCount || call.data.successCount)).toBe(false);
  });

  it("finishes the first queued settlement run and does not start the second", async () => {
    const fixture = clientFixture();
    fixture.client.market.findMany.mockResolvedValue([]);
    fixture.client.marketSettlementRun.findMany.mockResolvedValue([{ id: "first_run" }, { id: "second_run" }]);
    let stopping = false;
    const processRun = vi.fn(async () => { stopping = true; return { run: { status: "COMPLETED" } }; });
    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123", client: fixture.client as never, processRun: processRun as never, shouldStop: () => stopping,
    });
    expect(processRun).toHaveBeenCalledOnce();
    expect(processRun).toHaveBeenCalledWith({ actorUserId: "system_user", runId: "first_run", batchSize: 100 });
    expect(result).toMatchObject({ attemptedRuns: 1, completedRuns: 1, failedRuns: 0 });
    expect(fixture.workerState.updateMany.mock.calls.some(([call]) => call.data.failureCount || call.data.successCount)).toBe(false);
  });

  it.each(["market", "run"])("does not start a %s operation when stop arrives during its heartbeat", async (stage) => {
    const fixture = clientFixture();
    if (stage === "run") fixture.client.market.findMany.mockResolvedValue([]);
    let stopping = false;
    let heartbeats = 0;
    fixture.workerState.updateMany.mockImplementation(async () => {
      if (++heartbeats === 2) stopping = true; // Initial cycle ownership, then operation heartbeat.
      return { count: 1 };
    });
    const processRun = vi.fn();
    const result = await runSettlementWorkerCycle({
      instanceId: "worker_123", client: fixture.client as never, processRun: processRun as never, shouldStop: () => stopping,
    });
    expect(fixture.client.$transaction).not.toHaveBeenCalled();
    expect(processRun).not.toHaveBeenCalled();
    expect(result).toMatchObject({ closedMarkets: 0, attemptedRuns: 0, failedRuns: 0, marketCloseFailures: 0 });
    for (const [call] of fixture.workerState.updateMany.mock.calls) {
      expect(call.data).not.toHaveProperty("lastCycleSucceededAt");
      expect(call.data).not.toHaveProperty("consecutiveFailures");
      expect(call.data).not.toHaveProperty("lastError");
      expect(call.data).not.toHaveProperty("failureCount");
    }
  });
});
