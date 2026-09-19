import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  abbreviateWallet,
  fetchSolanaLeaderboard,
  parseSolanaLeaderboard,
  SolanaLeaderboardReadError,
  solanaLeaderboardReducer,
  SolanaLeaderboardView,
  type SolanaLeaderboardData,
  type SolanaLeaderboardState,
} from "./solana-leaderboard";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

const walletA = "8JkL3BGoGCgSAXZyJZbKDKCJvijocvLBaJcqF7iiM3fT";
const walletB = "5YLLBdpna7xmMBszQFyuEDaUEEiMziwdnjZeax3Ur8AH";
const startSignature = "1".repeat(64);
const headSignature = `${"1".repeat(63)}2`;

function data(
  coverage: SolanaLeaderboardData["coverage"]["status"] = "partial",
  truncated = false,
): SolanaLeaderboardData {
  const unavailable = coverage === "unavailable";
  return {
    metric: "taker_filled_contracts",
    rows: unavailable ? [] : [
      { rank: 1, walletAddress: walletA, filledContracts: "9007199254740993", filledOrderCommands: "4", orderCommands: "6", marketsTraded: 2 },
      { rank: 2, walletAddress: walletB, filledContracts: "19", filledOrderCommands: "2", orderCommands: "3", marketsTraded: 1 },
    ],
    participantCount: unavailable ? 0 : 2,
    observedOrderEvents: unavailable ? 0 : truncated ? 50_000 : 9,
    eventWindow: { limit: 50_000, truncated: unavailable ? false : truncated, semantics: "latest_finalized_order_events" },
    coverage: unavailable ? {
      status: "unavailable", coverageStartSignature: null, headSignature: null, backfillComplete: false,
      revision: null, updatedAt: null, fullHistory: false,
    } : {
      status: coverage, coverageStartSignature: startSignature, headSignature,
      backfillComplete: coverage === "bounded_complete", revision: 7,
      updatedAt: "2026-09-19T12:00:00.000Z", fullHistory: false,
    },
  };
}

function state(patch: Partial<SolanaLeaderboardState> = {}): SolanaLeaderboardState {
  return { requestId: 1, loading: false, data: data(), error: null, ...patch };
}

describe("finalized Solana leaderboard response boundary", () => {
  it("accepts the exact honest route contract and preserves exact u64 strings", () => {
    const parsed = parseSolanaLeaderboard(data("bounded_complete"));
    expect(parsed.metric).toBe("taker_filled_contracts");
    expect(parsed.rows[0]?.filledContracts).toBe("9007199254740993");
    expect(parsed.coverage).toMatchObject({ status: "bounded_complete", fullHistory: false });
  });

  it.each([
    { ...data(), secret: "rpc token" },
    { ...data(), metric: "net_worth" },
    { ...data(), participantCount: 1 },
    { ...data(), observedOrderEvents: 8 },
    { ...data(), observedOrderEvents: 50_001 },
    { ...data(), eventWindow: { ...data().eventWindow, semantics: "all_history" } },
    { ...data(), eventWindow: { ...data().eventWindow, truncated: true } },
    { ...data(), coverage: { ...data().coverage, fullHistory: true } },
    { ...data(), coverage: { ...data().coverage, backfillComplete: true } },
    { ...data("bounded_complete"), coverage: { ...data("bounded_complete").coverage, headSignature: null } },
    { ...data("unavailable"), participantCount: 1 },
  ])("rejects malformed, surplus, or contradictory top-level data", value => {
    expect(() => parseSolanaLeaderboard(value)).toThrow(SolanaLeaderboardReadError);
  });

  it.each([
    { rank: 2 },
    { walletAddress: "not-a-wallet" },
    { filledContracts: "01" },
    { filledContracts: "18446744073709551616" },
    { filledContracts: "0" },
    { filledOrderCommands: "7" },
    { marketsTraded: 5 },
    { extra: "injected" },
  ])("rejects malformed or contradictory row patch %j", patch => {
    const valid = data();
    const rows = [{ ...valid.rows[0], ...patch }, valid.rows[1]];
    expect(() => parseSolanaLeaderboard({ ...valid, rows })).toThrow(SolanaLeaderboardReadError);
  });

  it("rejects duplicate wallets and dishonest ranking order", () => {
    const valid = data();
    expect(() => parseSolanaLeaderboard({ ...valid, rows: [valid.rows[0], { ...valid.rows[1], walletAddress: walletA }] }))
      .toThrow(SolanaLeaderboardReadError);
    expect(() => parseSolanaLeaderboard({ ...valid, rows: [
      { ...valid.rows[0], filledContracts: "18" }, { ...valid.rows[1], filledContracts: "19" },
    ] })).toThrow(SolanaLeaderboardReadError);
  });

  it("requires an abortable same-origin no-store JSON request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response(JSON.stringify(data()), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=0, no-store" },
    }));
    await expect(fetchSolanaLeaderboard(controller.signal, fetcher)).resolves.toEqual(data());
    expect(fetcher).toHaveBeenCalledWith("/api/solana/leaderboard?limit=50", expect.objectContaining({
      method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json" },
    }));
  });

  it("rejects cacheable or non-JSON success responses", async () => {
    await expect(fetchSolanaLeaderboard(new AbortController().signal, vi.fn(async () =>
      new Response(JSON.stringify(data()), { status: 200, headers: { "Content-Type": "application/json" } }))))
      .rejects.toThrow("caching");
    await expect(fetchSolanaLeaderboard(new AbortController().signal, vi.fn(async () =>
      new Response("ok", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } }))))
      .rejects.toThrow("not JSON");
  });

  it("passes aborts through and maps sanitized HTTP failures without reading their body", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = fetchSolanaLeaderboard(controller.signal, fetcher);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (const [status, kind] of [[503, "unavailable"], [429, "rate-limited"], [500, "failed"]] as const) {
      await expect(fetchSolanaLeaderboard(new AbortController().signal, vi.fn(async () =>
        new Response("private database secret", { status, headers: { "Cache-Control": "private, no-store" } }))))
        .rejects.toMatchObject({ kind });
    }
  });
});

describe("finalized Solana leaderboard request state", () => {
  it("ignores stale successes and failures after a newer request starts", () => {
    const waiting = solanaLeaderboardReducer(state(), { type: "start", requestId: 2 });
    expect(solanaLeaderboardReducer(waiting, { type: "success", requestId: 1, data: data("unavailable") })).toBe(waiting);
    expect(solanaLeaderboardReducer(waiting, { type: "failure", requestId: 1, error: "stale" })).toBe(waiting);
    expect(solanaLeaderboardReducer(waiting, { type: "success", requestId: 2, data: data() }).loading).toBe(false);
  });

  it("invalidates old data after a failed refresh and while retrying that failure", () => {
    const failed = solanaLeaderboardReducer(state(), { type: "failure", requestId: 1, error: "unverified" });
    expect(failed.data).toBeNull();
    const retrying = solanaLeaderboardReducer(failed, { type: "start", requestId: 2 });
    expect(retrying.data).toBeNull();
    expect(retrying.loading).toBe(true);
  });
});

describe("finalized Solana leaderboard rendering", () => {
  const render = (value: SolanaLeaderboardState) => renderToStaticMarkup(
    React.createElement(SolanaLeaderboardView, { state: value, onRetry: vi.fn() }),
  );

  it("renders the exact metric without claiming broader financial rankings", () => {
    const html = render(state());
    expect(html).toContain("Taker filled contracts");
    expect(html).toContain("contracts filled by their submitted orders");
    expect(html).not.toMatch(/net worth|p&amp;l|profit|complete chain rankings/i);
  });

  it.each([
    ["partial", "Partial indexed coverage"],
    ["bounded_complete", "Bounded indexed window complete"],
    ["unavailable", "Coverage unavailable"],
  ] as const)("renders honest %s coverage wording", (coverage, copy) => {
    const html = render(state({ data: data(coverage) }));
    expect(html).toContain(copy);
    expect(html).toContain("fullHistory: false");
  });

  it("calls out a truncated latest-event window", () => {
    const html = render(state({ data: data("bounded_complete", true) }));
    expect(html).toContain("Truncated to the latest 50,000 finalized order events");
    expect(html).toContain("not full chain history");
  });

  it("abbreviates wallets visually while retaining their full titled and accessible value", () => {
    const html = render(state());
    expect(abbreviateWallet(walletA)).toBe("8JkL…M3fT");
    expect(html).toContain(`title="${walletA}"`);
    expect(html).toContain("8JkL…M3fT");
    expect(html).toContain(`>${walletA}</span>`);
  });

  it("provides accessible loading, empty, failure, retry, and refresh states", () => {
    const loading = render(state({ loading: true, data: null }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    const failed = render(state({ data: null, error: "The finalized-chain leaderboard is unavailable." }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Retry leaderboard");
    const empty = render(state({ data: data("unavailable") }));
    expect(empty).toContain("No observed taker fills");
    expect(render(state())).toContain(" Refresh</button>");
  });
});
