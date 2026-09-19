import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  effectiveSolanaIndexerWorkerState,
  fetchSolanaIndexerHealth,
  parseSolanaIndexerHealth,
  SolanaIndexerHealthReadError,
  solanaIndexerHealthReducer,
  SolanaIndexerHealthView,
  type SolanaIndexerHealthData,
  type SolanaIndexerHealthState,
} from "./solana-indexer-health";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

const data = (workerState: SolanaIndexerHealthData["worker"]["state"] = "running",
  coverageStatus: SolanaIndexerHealthData["coverage"]["status"] = "bounded_complete"): SolanaIndexerHealthData => ({
  worker: {
    state: workerState,
    updatedAt: workerState === "missing" ? null : "2026-09-19T12:00:00.000Z",
    cycleCount: workerState === "missing" ? "0" : "12",
    successCount: workerState === "missing" ? "0" : "10",
    failureCount: workerState === "missing" ? "0" : "1",
    consecutiveFailures: workerState === "failing" ? 1 : 0,
  },
  coverage: {
    status: coverageStatus,
    revision: coverageStatus === "unavailable" ? null : 7,
    updatedAt: coverageStatus === "unavailable" ? null : "2026-09-19T11:59:00.000Z",
    fullHistory: false,
  },
});

const state = (patch: Partial<SolanaIndexerHealthState> = {}): SolanaIndexerHealthState => ({
  requestId: 1,
  loading: false,
  data: data(),
  error: null,
  ...patch,
});

describe("Solana indexer health response boundary", () => {
  it("accepts the exact route contract and preserves signed-BigInt-range decimal counters", () => {
    const initial = data();
    const value = { ...initial, worker: { ...initial.worker, cycleCount: "9223372036854775807" } };
    expect(parseSolanaIndexerHealth(value).worker.cycleCount).toBe("9223372036854775807");
  });

  it.each([
    { ...data(), extra: true },
    { ...data(), worker: { ...data().worker, secret: "rpc-token" } },
    { ...data(), worker: { ...data().worker, cycleCount: "01" } },
    { ...data(), worker: { ...data().worker, cycleCount: "9223372036854775808" } },
    { ...data(), worker: { ...data().worker, successCount: "13" } },
    { ...data(), worker: { ...data().worker, updatedAt: "September 19" } },
    { ...data("missing"), worker: { ...data("missing").worker, cycleCount: "1" } },
    { ...data("running"), worker: { ...data().worker, consecutiveFailures: 1 } },
    { ...data("failing"), worker: { ...data("failing").worker, consecutiveFailures: 0 } },
    { ...data(), coverage: { ...data().coverage, fullHistory: true } },
    { ...data(), coverage: { status: "unavailable", revision: 1, updatedAt: null, fullHistory: false } },
  ])("rejects malformed, surplus, or contradictory data", (value) => {
    expect(() => parseSolanaIndexerHealth(value)).toThrow(SolanaIndexerHealthReadError);
  });

  it("uses an abortable same-origin no-store request and enforces uncached JSON", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(data()), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    }));
    await expect(fetchSolanaIndexerHealth(controller.signal, fetcher)).resolves.toEqual(data());
    expect(fetcher).toHaveBeenCalledWith("/api/solana/indexer/status", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json" },
    }));
    await expect(fetchSolanaIndexerHealth(new AbortController().signal,
      vi.fn(async () => new Response(JSON.stringify(data()), { status: 200,
        headers: { "Content-Type": "application/json" } })))).rejects.toThrow("caching");
    await expect(fetchSolanaIndexerHealth(new AbortController().signal,
      vi.fn(async () => new Response("ok", { status: 200,
        headers: { "Content-Type": "text/plain", "Cache-Control": "private, no-store" } })))).rejects.toThrow("JSON");
  });

  it("passes abort through and sanitizes HTTP failures without reading response bodies", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = fetchSolanaIndexerHealth(controller.signal, fetcher);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (const [status, kind] of [[503, "unavailable"], [429, "rate-limited"], [500, "failed"]] as const) {
      await expect(fetchSolanaIndexerHealth(new AbortController().signal,
        vi.fn(async () => new Response("private provider secret", { status,
          headers: { "Cache-Control": "private, no-store" } })))).rejects.toMatchObject({ kind });
    }
  });
});

describe("Solana indexer health state", () => {
  it("ignores stale successes and failures after a newer request begins", () => {
    const waiting = solanaIndexerHealthReducer(state(), { type: "start", requestId: 2 });
    const staleSuccess = solanaIndexerHealthReducer(waiting, { type: "success", requestId: 1, data: data("stopped") });
    const staleFailure = solanaIndexerHealthReducer(waiting, { type: "failure", requestId: 1, error: "stale" });
    expect(staleSuccess).toBe(waiting);
    expect(staleFailure).toBe(waiting);
    expect(solanaIndexerHealthReducer(waiting, { type: "success", requestId: 2, data: data() }).loading).toBe(false);
  });

  it("does not resurrect an invalidated snapshot while retrying a failed read", () => {
    const failed = state({ data: data("running"), error: "unverified" });
    const retrying = solanaIndexerHealthReducer(failed, { type: "start", requestId: 2 });
    expect(retrying.data).toBeNull();
    expect(retrying.loading).toBe(true);
  });

  it("downgrades a locally aged running heartbeat and never upgrades server-declared problems", () => {
    const worker = data().worker;
    expect(effectiveSolanaIndexerWorkerState(worker, Date.parse(worker.updatedAt!) + 179_999)).toBe("running");
    expect(effectiveSolanaIndexerWorkerState(worker, Date.parse(worker.updatedAt!) + 180_000)).toBe("stale");
    for (const value of ["missing", "stopped", "stale", "failing"] as const) {
      expect(effectiveSolanaIndexerWorkerState(data(value).worker, Date.now())).toBe(value);
    }
  });
});

describe("Solana indexer health rendering", () => {
  const render = (value: SolanaIndexerHealthState, now = Date.parse("2026-09-19T12:00:30.000Z")) =>
    renderToStaticMarkup(React.createElement(SolanaIndexerHealthView, { state: value, now, onRetry: vi.fn() }));

  it.each([
    ["running", "Indexer running"],
    ["stale", "Updates stale"],
    ["failing", "Indexer failing"],
    ["stopped", "Indexer stopped"],
    ["missing", "Indexer not observed"],
  ] as const)("renders %s without collapsing it into a live state", (workerState, label) => {
    const html = render(state({ data: data(workerState) }));
    expect(html).toContain(label);
    if (workerState !== "running") expect(html).not.toContain("The latest worker heartbeat is current");
  });

  it.each([
    ["partial", "Partial coverage"],
    ["bounded_complete", "Bounded window complete"],
    ["unavailable", "Coverage unavailable"],
  ] as const)("renders honest %s coverage with an explicit full-history disclosure", (coverage, label) => {
    const html = render(state({ data: data("running", coverage) }));
    expect(html).toContain(label);
    expect(html).toContain("fullHistory: false");
    expect(html).not.toMatch(/complete chain history/i);
  });

  it("does not show a green operational badge when coverage is unavailable", () => {
    const html = render(state({ data: data("running", "unavailable") }));
    expect(html).toContain("Coverage unavailable");
    expect(html).toContain('data-health-state="coverage-unavailable"');
    expect(html).not.toContain('data-health-state="running"');
  });

  it("provides accessible loading, failure, retry, and refresh states", () => {
    const loading = render(state({ loading: true, data: null }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    const failed = render(state({ data: null, error: "Public indexer status is unavailable." }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Retry status check");
    expect(render(state())).toContain("Refresh status");
  });

  it("removes a previously green snapshot when a refresh can no longer verify status", () => {
    const html = render(state({ data: data("running"), error: "Indexer status could not be verified." }));
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Indexer running");
    expect(html).not.toContain("The latest worker heartbeat is current");
  });
});
