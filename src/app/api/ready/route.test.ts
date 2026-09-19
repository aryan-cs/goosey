import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  readWorkerReadiness: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: mocks.queryRaw },
}));

vi.mock("@/lib/worker-health", () => ({
  readWorkerReadiness: mocks.readWorkerReadiness,
}));

import { GET } from "./route";

describe("GET /api/ready", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset().mockResolvedValue([{ 1: 1 }]);
    mocks.readWorkerReadiness.mockReset();
  });

  it("returns 503 with stable reason codes when worker readiness fails", async () => {
    mocks.readWorkerReadiness.mockResolvedValue({
      ready: false,
      checkedAt: new Date("2026-09-19T12:00:00.000Z"),
      worker: null,
      backlog: {
        expiredMarketCount: 0,
        oldestExpiredMarketAt: null,
        activeSettlementRunCount: 0,
        oldestActiveSettlementRunAt: null,
        expiredLeaseCount: 0,
        oldestExpiredLeaseAt: null,
      },
      reasons: [{ code: "WORKER_MISSING", message: "The settlement worker has not registered." }],
    });

    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      reasons: [{ code: "WORKER_MISSING" }],
    });
  });

  it("returns 200 only when the worker and backlog are ready", async () => {
    mocks.readWorkerReadiness.mockResolvedValue({
      ready: true,
      checkedAt: new Date("2026-09-19T12:00:00.000Z"),
      worker: { status: "RUNNING", lastHeartbeatAt: new Date(), lastCycleSucceededAt: new Date(), consecutiveFailures: 0 },
      backlog: {
        expiredMarketCount: 0,
        oldestExpiredMarketAt: null,
        activeSettlementRunCount: 0,
        oldestActiveSettlementRunAt: null,
        expiredLeaseCount: 0,
        oldestExpiredLeaseAt: null,
      },
      reasons: [],
    });

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "ready", reasons: [] });
  });

  it("fails closed without leaking dependency errors", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("password=secret"));
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body.reasons[0].code).toBe("READINESS_CHECK_FAILED");
  });
});
