import type { WorkerState } from "@prisma/client";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";

import {
  beginContinuousSolanaIndexerCycle,
  heartbeatContinuousSolanaIndexer,
  isAbortFromSignal,
  readPublicSolanaIndexerStatus,
  registerContinuousSolanaIndexer,
  runOwnedContinuousSolanaIndexerCycle,
  sanitizedIndexerErrorType,
  solanaIndexerWorkerIdentity,
  SolanaIndexerAlreadyActiveError,
  SolanaIndexerOwnershipLostError,
  stopContinuousSolanaIndexer,
  succeedContinuousSolanaIndexerCycle,
} from "./indexer-health";
import type { SolanaRuntime } from "./runtime";

const deployment: SolanaRuntime = {
  cluster: "localnet" as const,
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  rpcUrl: "https://private.invalid/rpc?api-key=never-persist-this",
};
const epoch = new Date("2026-09-19T12:00:00.000Z");

type Cursor = {
  committedHeadSignature: string | null;
  scanHeadSignature: string | null;
  scanBeforeSignature: string | null;
  backfillComplete: boolean;
  revision: number;
  updatedAt: Date;
};

function worker(overrides: Partial<WorkerState> = {}): WorkerState {
  const identity = solanaIndexerWorkerIdentity(deployment);
  return {
    id: identity.workerId,
    workerName: identity.workerName,
    instanceId: "instance-a",
    status: "RUNNING",
    startedAt: epoch,
    lastHeartbeatAt: epoch,
    lastCycleStartedAt: null,
    lastCycleSucceededAt: null,
    lastCycleFailedAt: null,
    stoppedAt: null,
    consecutiveFailures: 0,
    lastError: null,
    cycleCount: 0n,
    successCount: 0n,
    failureCount: 0n,
    closedMarketCount: 0n,
    completedRunCount: 0n,
    createdAt: epoch,
    updatedAt: epoch,
    ...overrides,
  };
}

function fakeClient(initial: WorkerState | null = null) {
  let row = initial;
  let cursor: Cursor | null = null;

  function simpleMatch(candidate: WorkerState, condition: Record<string, unknown>) {
    if (condition.instanceId !== undefined && candidate.instanceId !== condition.instanceId) return false;
    if (condition.id !== undefined && candidate.id !== condition.id) return false;
    if (condition.workerName !== undefined && candidate.workerName !== condition.workerName) return false;
    if (typeof condition.status === "string" && candidate.status !== condition.status) return false;
    if (condition.status && typeof condition.status === "object" && "not" in condition.status
      && candidate.status === condition.status.not) return false;
    if (condition.lastHeartbeatAt && typeof condition.lastHeartbeatAt === "object" && "lte" in condition.lastHeartbeatAt
      && candidate.lastHeartbeatAt > (condition.lastHeartbeatAt.lte as Date)) return false;
    return true;
  }
  function matches(candidate: WorkerState, where: Record<string, unknown>) {
    if (!simpleMatch(candidate, where)) return false;
    const alternatives = where.OR as Array<Record<string, unknown>> | undefined;
    return !alternatives || alternatives.some(alternative => simpleMatch(candidate, alternative));
  }
  function apply(data: Record<string, unknown>) {
    if (!row) return;
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        const current = row[key as keyof WorkerState] as bigint | number;
        (row as unknown as Record<string, unknown>)[key] = current + (value.increment as never);
      } else {
        (row as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (data.lastHeartbeatAt instanceof Date) row.updatedAt = data.lastHeartbeatAt;
  }
  const client = {
    workerState: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!row || !matches(row, where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (row) throw Object.assign(new Error("unique conflict contains no useful secret"), { code: "P2002" });
        row = worker(data as Partial<WorkerState>);
        return row;
      },
      findUnique: async () => row,
    },
    solanaIngestionCursor: { findUnique: async () => cursor },
  };
  return {
    client: client as never,
    get row() { return row; },
    setRow(value: WorkerState | null) { row = value; },
    setCursor(value: Cursor | null) { cursor = value; },
  };
}

describe("continuous Solana indexer lease and health", () => {
  it("derives a bounded deterministic deployment identity without using the RPC URL", () => {
    const first = solanaIndexerWorkerIdentity(deployment);
    const rotated: SolanaRuntime = { ...deployment, rpcUrl: "https://other.invalid/secret" };
    const other: SolanaRuntime = { ...deployment, genesisHash: deployment.programAddress };
    expect(first).toEqual(solanaIndexerWorkerIdentity(rotated));
    expect(first).not.toEqual(solanaIndexerWorkerIdentity(other));
    expect(first.workerId).toMatch(/^solana-indexer-[a-f0-9]{32}$/);
    expect(first.workerName).toBe(first.workerId);
    expect(first.workerId.length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(first)).not.toContain("private");
    expect(JSON.stringify(first)).not.toContain("api-key");
  });

  it("allows exactly one of two concurrent registrations", async () => {
    const store = fakeClient();
    const attempts = await Promise.allSettled([
      registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "first", now: epoch }),
      registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "second", now: epoch }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SolanaIndexerAlreadyActiveError);
    expect(["first", "second"]).toContain(store.row?.instanceId);
  });

  it("rejects a fresh owner and permits exactly one bounded stale takeover", async () => {
    const identity = solanaIndexerWorkerIdentity(deployment);
    const store = fakeClient(worker({ ...identity, instanceId: "old", lastHeartbeatAt: epoch }));
    await expect(registerContinuousSolanaIndexer(deployment, {
      client: store.client, instanceId: "too-soon", now: new Date(epoch.getTime() + 179_999),
    })).rejects.toBeInstanceOf(SolanaIndexerAlreadyActiveError);
    const takeoverAt = new Date(epoch.getTime() + 180_001);
    const attempts = await Promise.allSettled([
      registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "new-a", now: takeoverAt }),
      registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "new-b", now: takeoverAt }),
    ]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(store.row?.instanceId).not.toBe("old");
    expect(store.row?.lastHeartbeatAt).toEqual(takeoverAt);
  });

  it("rejects invalid unbounded stale policies before any database mutation", async () => {
    const store = fakeClient();
    await expect(registerContinuousSolanaIndexer(deployment, {
      client: store.client, staleAfterMs: 999,
    })).rejects.toThrow("stale-heartbeat policy");
    await expect(registerContinuousSolanaIndexer(deployment, {
      client: store.client, staleAfterMs: 300_001,
    })).rejects.toThrow("stale-heartbeat policy");
    expect(store.row).toBeNull();
  });

  it("heartbeats before and after success while tracking exact counters", async () => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const started = new Date(epoch.getTime() + 1_000), finished = new Date(epoch.getTime() + 2_000);
    const times = [started, finished];
    await expect(runOwnedContinuousSolanaIndexerCycle(lease, async () => "indexed", {
      client: store.client, now: () => times.shift()!,
    })).resolves.toBe("indexed");
    expect(store.row).toMatchObject({ cycleCount: 1n, successCount: 1n, failureCount: 0n,
      consecutiveFailures: 0, lastCycleStartedAt: started, lastCycleSucceededAt: finished,
      lastHeartbeatAt: finished, lastError: null });
  });

  it("records only a sanitized failure type, then clears failure health after success", async () => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const provider = Object.assign(new Error("private RPC https://secret.invalid/?token=abc"), { name: "SignatureHistoryGapError" });
    await expect(runOwnedContinuousSolanaIndexerCycle(lease, async () => { throw provider; }, {
      client: store.client,
    })).rejects.toBe(provider);
    expect(store.row).toMatchObject({ cycleCount: 1n, successCount: 0n, failureCount: 1n,
      consecutiveFailures: 1, lastError: "SignatureHistoryGapError" });
    expect(store.row?.lastError).not.toContain("secret.invalid");
    await runOwnedContinuousSolanaIndexerCycle(lease, async () => undefined, { client: store.client });
    expect(store.row).toMatchObject({ cycleCount: 2n, successCount: 1n, failureCount: 1n,
      consecutiveFailures: 0, lastError: null });
    expect(sanitizedIndexerErrorType({ code: "P2024", message: "password" })).toBe("PRISMA_P2024");
    expect(sanitizedIndexerErrorType(Object.assign(new Error("secret"), { name: "bad name / secret" })))
      .toBe("INDEXER_CYCLE_FAILED");
  });

  it("treats only the process-stop signal's own AbortError as a clean interrupted cycle", async () => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const stopping = new AbortController();
    stopping.abort();
    const abort = stopping.signal.reason;
    const started = new Date(epoch.getTime() + 1_000), interrupted = new Date(epoch.getTime() + 2_000);
    const times = [started, interrupted];
    await expect(runOwnedContinuousSolanaIndexerCycle(lease, async () => { throw abort; }, {
      client: store.client,
      gracefulStopSignal: stopping.signal,
      now: () => times.shift()!,
    })).rejects.toBe(abort);
    expect(store.row).toMatchObject({ status: "RUNNING", cycleCount: 1n, successCount: 0n, failureCount: 0n,
      consecutiveFailures: 0, lastCycleStartedAt: started, lastCycleFailedAt: null,
      lastHeartbeatAt: interrupted, lastError: null });

    const stoppedAt = new Date(epoch.getTime() + 3_000);
    await stopContinuousSolanaIndexer(lease, store.client, stoppedAt);
    const status = await readPublicSolanaIndexerStatus(deployment, { client: store.client, now: stoppedAt });
    expect(status.worker).toMatchObject({ state: "stopped", failureCount: "0", consecutiveFailures: 0 });
    expect(isAbortFromSignal(abort, stopping.signal)).toBe(true);
    const wrapped = Object.assign(new Error("wrapped stop"), { name: "AbortError", cause: abort });
    expect(isAbortFromSignal(wrapped, stopping.signal)).toBe(true);
  });

  it.each([
    Object.assign(new Error("cycle deadline reached"), { name: "TimeoutError" }),
    Object.assign(new Error("provider disconnected"), { name: "ProviderTransportError" }),
    Object.assign(new Error("unrelated provider abort"), { name: "AbortError" }),
  ])("records non-stop operation failure $name even when a stop signal exists", async failure => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const stopping = new AbortController();
    // For the unrelated AbortError case, an already-aborted stop signal still
    // must not suppress a different error object with no matching cause.
    if (failure.name === "AbortError") stopping.abort();
    await expect(runOwnedContinuousSolanaIndexerCycle(lease, async () => { throw failure; }, {
      client: store.client,
      gracefulStopSignal: stopping.signal,
    })).rejects.toBe(failure);
    expect(store.row).toMatchObject({ cycleCount: 1n, successCount: 0n, failureCount: 1n,
      consecutiveFailures: 1, lastCycleFailedAt: expect.any(Date), lastError: failure.name });
    expect(isAbortFromSignal(failure, stopping.signal)).toBe(false);
  });

  it("fails closed before work and after work whenever ownership is lost", async () => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const wrong = { ...lease, instanceId: "intruder" };
    await expect(heartbeatContinuousSolanaIndexer(wrong, store.client)).rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    await expect(beginContinuousSolanaIndexerCycle(wrong, store.client)).rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    await expect(succeedContinuousSolanaIndexerCycle(wrong, store.client)).rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    await expect(stopContinuousSolanaIndexer(wrong, store.client)).rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    let operationRan = false;
    await expect(runOwnedContinuousSolanaIndexerCycle(wrong, async () => { operationRan = true; }, { client: store.client }))
      .rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    expect(operationRan).toBe(false);

    await expect(runOwnedContinuousSolanaIndexerCycle(lease, async () => {
      store.setRow(worker({ ...solanaIndexerWorkerIdentity(deployment), instanceId: "takeover" }));
      return "cursor may already be committed";
    }, { client: store.client })).rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    expect(store.row).toMatchObject({ instanceId: "takeover", cycleCount: 0n, failureCount: 0n });

    const abortStore = fakeClient();
    const abortLease = await registerContinuousSolanaIndexer(deployment, {
      client: abortStore.client, instanceId: "abort-owner", now: epoch,
    });
    const stopping = new AbortController();
    stopping.abort();
    await expect(runOwnedContinuousSolanaIndexerCycle(abortLease, async () => {
      abortStore.setRow(worker({ ...solanaIndexerWorkerIdentity(deployment), instanceId: "abort-takeover" }));
      throw stopping.signal.reason;
    }, { client: abortStore.client, gracefulStopSignal: stopping.signal }))
      .rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
    expect(abortStore.row).toMatchObject({ instanceId: "abort-takeover", failureCount: 0n });
  });

  it("marks a gracefully stopped owner without allowing it to heartbeat again", async () => {
    const store = fakeClient();
    const lease = await registerContinuousSolanaIndexer(deployment, { client: store.client, instanceId: "owner", now: epoch });
    const stoppedAt = new Date(epoch.getTime() + 5_000);
    await stopContinuousSolanaIndexer(lease, store.client, stoppedAt);
    expect(store.row).toMatchObject({ status: "STOPPED", stoppedAt, lastHeartbeatAt: stoppedAt });
    await expect(heartbeatContinuousSolanaIndexer(lease, store.client))
      .rejects.toBeInstanceOf(SolanaIndexerOwnershipLostError);
  });

  it.each([
    [null, "missing"],
    [worker({ status: "STOPPED" }), "stopped"],
    [worker({ status: "STOPPED", consecutiveFailures: 1, lastError: "FatalCycleError" }), "failing"],
    [worker({ lastHeartbeatAt: new Date(epoch.getTime() - 180_000) }), "stale"],
    [worker({ consecutiveFailures: 2, lastError: "PrivateProviderError" }), "failing"],
    [worker(), "running"],
  ] as const)("classifies public worker health as %s => %s", async (row, state) => {
    const store = fakeClient(row);
    const result = await readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch });
    expect(result.worker.state).toBe(state);
    const text = JSON.stringify(result);
    for (const hidden of ["instance-a", "PrivateProviderError", "private.invalid", "rpcUrl"]) expect(text).not.toContain(hidden);
  });

  it("reports unavailable, partial, and bounded-complete coverage without signatures or full-history claims", async () => {
    const store = fakeClient(worker());
    await expect(readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch }))
      .resolves.toMatchObject({ coverage: { status: "unavailable", revision: null, updatedAt: null, fullHistory: false } });
    store.setCursor({ committedHeadSignature: null, scanHeadSignature: "scan-secret", scanBeforeSignature: "tail-secret",
      backfillComplete: false, revision: 7, updatedAt: epoch });
    const partial = await readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch });
    expect(partial.coverage).toEqual({ status: "partial", revision: 7, updatedAt: epoch.toISOString(), fullHistory: false });
    expect(JSON.stringify(partial)).not.toContain("secret");
    store.setCursor({ committedHeadSignature: "head-secret", scanHeadSignature: null, scanBeforeSignature: null,
      backfillComplete: true, revision: 8, updatedAt: epoch });
    await expect(readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch }))
      .resolves.toMatchObject({ coverage: { status: "bounded_complete", revision: 8, fullHistory: false } });
  });

  it("fails closed on inconsistent cursor coverage rather than publishing a false status", async () => {
    const store = fakeClient(worker());
    store.setCursor({ committedHeadSignature: null, scanHeadSignature: null, scanBeforeSignature: "tail",
      backfillComplete: true, revision: 1, updatedAt: epoch });
    await expect(readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch }))
      .rejects.toThrow("Inconsistent stored ingestion coverage");
  });

  it("fails closed on a mismatched persisted worker identity", async () => {
    const store = fakeClient(worker({ workerName: "unrelated-worker" }));
    await expect(readPublicSolanaIndexerStatus(deployment, { client: store.client, now: epoch }))
      .rejects.toThrow("Inconsistent stored indexer identity");
  });
});
