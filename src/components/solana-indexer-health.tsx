"use client";

import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";

import styles from "./solana-indexer-health.module.css";

const STALE_AFTER_MS = 180_000;
const REFRESH_INTERVAL_MS = 60_000;
const UINT_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const SIGNED_BIGINT_MAX = 9_223_372_036_854_775_807n;

export type SolanaIndexerWorkerState = "missing" | "stopped" | "stale" | "failing" | "running";
export type SolanaIndexerCoverageState = "unavailable" | "partial" | "bounded_complete";

export type SolanaIndexerHealthData = Readonly<{
  worker: Readonly<{
    state: SolanaIndexerWorkerState;
    updatedAt: string | null;
    cycleCount: string;
    successCount: string;
    failureCount: string;
    consecutiveFailures: number;
  }>;
  coverage: Readonly<{
    status: SolanaIndexerCoverageState;
    revision: number | null;
    updatedAt: string | null;
    fullHistory: false;
  }>;
}>;

export type SolanaIndexerHealthState = Readonly<{
  requestId: number;
  loading: boolean;
  data: SolanaIndexerHealthData | null;
  error: string | null;
}>;

export type SolanaIndexerHealthAction =
  | Readonly<{ type: "start"; requestId: number }>
  | Readonly<{ type: "success"; requestId: number; data: SolanaIndexerHealthData }>
  | Readonly<{ type: "failure"; requestId: number; error: string }>;

export class SolanaIndexerHealthReadError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "rate-limited" | "failed" = "failed") {
    super(message);
    this.name = "SolanaIndexerHealthReadError";
  }
}

function ownRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function unsignedInteger(value: unknown): value is string {
  return typeof value === "string" && UINT_PATTERN.test(value) && BigInt(value) <= SIGNED_BIGINT_MAX;
}

export function parseSolanaIndexerHealth(value: unknown): SolanaIndexerHealthData {
  if (!ownRecord(value) || !exactKeys(value, ["worker", "coverage"]) || !ownRecord(value.worker)
    || !exactKeys(value.worker, ["state", "updatedAt", "cycleCount", "successCount", "failureCount", "consecutiveFailures"])
    || !ownRecord(value.coverage)
    || !exactKeys(value.coverage, ["status", "revision", "updatedAt", "fullHistory"])) {
    throw new SolanaIndexerHealthReadError("Invalid indexer health response");
  }

  const worker = value.worker;
  const workerStates: readonly SolanaIndexerWorkerState[] = ["missing", "stopped", "stale", "failing", "running"];
  if (!workerStates.includes(worker.state as SolanaIndexerWorkerState)
    || !unsignedInteger(worker.cycleCount) || !unsignedInteger(worker.successCount) || !unsignedInteger(worker.failureCount)
    || !Number.isSafeInteger(worker.consecutiveFailures) || (worker.consecutiveFailures as number) < 0
    || (worker.updatedAt !== null && !canonicalTimestamp(worker.updatedAt))) {
    throw new SolanaIndexerHealthReadError("Invalid indexer worker status");
  }
  const cycleCount = BigInt(worker.cycleCount);
  const successCount = BigInt(worker.successCount);
  const failureCount = BigInt(worker.failureCount);
  if (successCount + failureCount > cycleCount
    || (worker.state === "missing" && (worker.updatedAt !== null || cycleCount !== 0n || successCount !== 0n
      || failureCount !== 0n || worker.consecutiveFailures !== 0))
    || (worker.state !== "missing" && worker.updatedAt === null)
    || ((worker.state === "running" || worker.state === "stopped") && worker.consecutiveFailures !== 0)
    || (worker.state === "failing" && worker.consecutiveFailures === 0)) {
    throw new SolanaIndexerHealthReadError("Contradictory indexer worker status");
  }

  const coverage = value.coverage;
  const coverageStates: readonly SolanaIndexerCoverageState[] = ["unavailable", "partial", "bounded_complete"];
  if (!coverageStates.includes(coverage.status as SolanaIndexerCoverageState) || coverage.fullHistory !== false) {
    throw new SolanaIndexerHealthReadError("Invalid indexer coverage status");
  }
  if (coverage.status === "unavailable") {
    if (coverage.revision !== null || coverage.updatedAt !== null) {
      throw new SolanaIndexerHealthReadError("Contradictory unavailable coverage");
    }
  } else if (!Number.isSafeInteger(coverage.revision) || (coverage.revision as number) < 0
    || !canonicalTimestamp(coverage.updatedAt)) {
    throw new SolanaIndexerHealthReadError("Invalid indexer coverage revision");
  }

  return value as SolanaIndexerHealthData;
}

function hasNoStore(response: Response) {
  return (response.headers.get("cache-control") ?? "").split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store");
}

export async function fetchSolanaIndexerHealth(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<SolanaIndexerHealthData> {
  const response = await fetcher("/api/solana/indexer/status", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!hasNoStore(response)) throw new SolanaIndexerHealthReadError("Indexer health response allowed caching");
  if (!response.ok) {
    if (response.status === 429) throw new SolanaIndexerHealthReadError("Status checks are temporarily rate limited.", "rate-limited");
    if (response.status === 503) throw new SolanaIndexerHealthReadError("Public indexer status is unavailable.", "unavailable");
    throw new SolanaIndexerHealthReadError("Indexer status could not be verified.");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new SolanaIndexerHealthReadError("Indexer health response was not JSON");
  }
  return parseSolanaIndexerHealth(await response.json());
}

export function solanaIndexerHealthReducer(
  state: SolanaIndexerHealthState,
  action: SolanaIndexerHealthAction,
): SolanaIndexerHealthState {
  if (action.type === "start") return {
    ...state,
    requestId: action.requestId,
    loading: true,
    data: state.error ? null : state.data,
    error: null,
  };
  if (action.requestId !== state.requestId) return state;
  if (action.type === "success") return { ...state, loading: false, data: action.data, error: null };
  return { ...state, loading: false, error: action.error };
}

export function effectiveSolanaIndexerWorkerState(
  worker: SolanaIndexerHealthData["worker"],
  now = Date.now(),
): SolanaIndexerWorkerState {
  if (worker.state !== "running" || worker.updatedAt === null) return worker.state;
  return now - new Date(worker.updatedAt).getTime() >= STALE_AFTER_MS ? "stale" : "running";
}

function formatTimestamp(value: string | null) {
  if (value === null) return "Not available";
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Toronto",
    timeZoneName: "short",
  }).format(new Date(value));
}

const workerCopy: Record<SolanaIndexerWorkerState, Readonly<{ label: string; detail: string }>> = {
  running: { label: "Indexer running", detail: "The latest worker heartbeat is current." },
  stale: { label: "Updates stale", detail: "The last worker heartbeat is no longer current." },
  failing: { label: "Indexer failing", detail: "Recent indexing cycles have failed." },
  stopped: { label: "Indexer stopped", detail: "The continuous indexer is not running." },
  missing: { label: "Indexer not observed", detail: "No worker status has been recorded for this deployment." },
};

const coverageCopy: Record<SolanaIndexerCoverageState, Readonly<{ label: string; detail: string }>> = {
  bounded_complete: { label: "Bounded window complete", detail: "The retained indexed window is complete, but this is not full chain history." },
  partial: { label: "Partial coverage", detail: "Backfill is still in progress. Indexed results may omit older activity." },
  unavailable: { label: "Coverage unavailable", detail: "No verified ingestion coverage is available." },
};

export function SolanaIndexerHealthView({
  state,
  now,
  onRetry,
}: Readonly<{ state: SolanaIndexerHealthState; now: number; onRetry: () => void }>) {
  const headingId = useId();
  // A failed refresh invalidates the old operational snapshot. Do not leave a
  // green status visible when the public endpoint can no longer verify it.
  const visibleData = state.error ? null : state.data;
  const workerState = visibleData ? effectiveSolanaIndexerWorkerState(visibleData.worker, now) : null;
  const worker = workerState ? workerCopy[workerState] : null;
  const coverage = visibleData ? coverageCopy[visibleData.coverage.status] : null;
  const coverageUnavailable = visibleData?.coverage.status === "unavailable";
  const badgeClass = coverageUnavailable && workerState === "running" ? "stopped" : workerState;
  const badgeLabel = coverageUnavailable && workerState === "running" ? "Coverage unavailable" : worker?.label;

  return <section className={styles.card} aria-labelledby={headingId} aria-busy={state.loading}>
    <header className={styles.header}>
      <div>
        <span className={styles.eyebrow}>Goosey chain operations</span>
        <h2 id={headingId}>Solana indexer health</h2>
      </div>
      {workerState && badgeClass ? <span className={`${styles.badge} ${styles[badgeClass]}`}
        data-health-state={coverageUnavailable && workerState === "running" ? "coverage-unavailable" : workerState}>
        <span className={styles.dot} aria-hidden="true" />{badgeLabel}
      </span> : null}
    </header>

    {visibleData && worker && coverage ? <div className={styles.content}>
      <div className={styles.summary}>
        <div>
          <span className={styles.label}>Worker</span>
          <strong>{worker.label}</strong>
          <p>{worker.detail}</p>
        </div>
        <div>
          <span className={styles.label}>Indexed coverage</span>
          <strong>{coverage.label}</strong>
          <p>{coverage.detail}</p>
        </div>
      </div>
      <dl className={styles.metrics}>
        <div><dt>Cycles</dt><dd>{visibleData.worker.cycleCount}</dd></div>
        <div><dt>Succeeded</dt><dd>{visibleData.worker.successCount}</dd></div>
        <div><dt>Failed</dt><dd>{visibleData.worker.failureCount}</dd></div>
        <div><dt>Consecutive failures</dt><dd>{visibleData.worker.consecutiveFailures}</dd></div>
      </dl>
      <dl className={styles.timestamps}>
        <div><dt>Worker reported</dt><dd>{formatTimestamp(visibleData.worker.updatedAt)}</dd></div>
        <div><dt>Coverage updated</dt><dd>{formatTimestamp(visibleData.coverage.updatedAt)}</dd></div>
        <div><dt>Coverage revision</dt><dd>{visibleData.coverage.revision ?? "Not available"}</dd></div>
      </dl>
      <p className={styles.disclosure}>Operational metadata only · fullHistory: false</p>
    </div> : null}

    {state.loading ? <p className={styles.notice} role="status">Checking verified indexer status…</p> : null}
    {state.error ? <div className={styles.error} role="alert">
      <p>{state.error}</p>
      <button type="button" onClick={onRetry} disabled={state.loading}>Retry status check</button>
    </div> : null}
    {!state.error && !state.loading ? <button className={styles.refresh} type="button" onClick={onRetry}>
      Refresh status
    </button> : null}
  </section>;
}

export function SolanaIndexerHealth() {
  const [state, dispatch] = useReducer(solanaIndexerHealthReducer, {
    requestId: 0,
    loading: true,
    data: null,
    error: null,
  });
  const active = useRef<{ requestId: number; controller: AbortController } | null>(null);
  const nextRequestId = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    active.current?.controller.abort();
    const requestId = ++nextRequestId.current;
    const controller = new AbortController();
    active.current = { requestId, controller };
    dispatch({ type: "start", requestId });
    void fetchSolanaIndexerHealth(controller.signal).then(
      (data) => dispatch({ type: "success", requestId, data }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof SolanaIndexerHealthReadError
          ? error.message
          : "Indexer status could not be verified.";
        dispatch({ type: "failure", requestId, error: message });
      },
    );
  }, []);

  useEffect(() => {
    load();
    const refresh = window.setInterval(load, REFRESH_INTERVAL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(refresh);
      window.clearInterval(clock);
      active.current?.controller.abort();
    };
  }, [load]);

  return <SolanaIndexerHealthView state={state} now={now} onRetry={load} />;
}
