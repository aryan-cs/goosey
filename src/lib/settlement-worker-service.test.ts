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
});
