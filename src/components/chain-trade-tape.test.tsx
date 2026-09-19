import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ChainTradeTape,
  ChainTradeTapeView,
  chainTradeTapeReducer,
  fetchChainTradePage,
  formatImpliedProbability,
  mergeChainTrades,
  parseChainTradePage,
  type ChainTrade,
  type ChainTradePage,
  type ChainTradeTapeState,
} from "./chain-trade-tape";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

const signatureA = "5".repeat(64);
const signatureB = "6".repeat(64);
const signatureC = "7".repeat(64);
const trade = (overrides: Partial<ChainTrade> = {}): ChainTrade => ({
  signature: signatureA,
  slot: "18446744073709551615",
  logIndex: 2,
  makerOrderId: "18446744073709551615",
  takerOrderId: "2",
  makerSeat: "0",
  takerSeat: "18446744073709551615",
  quantity: "9007199254740993",
  yesPrice: "1",
  makerFee: "0",
  takerFee: "3",
  makerOutcome: "YES",
  makerAction: "SELL",
  takerOutcome: "YES",
  takerAction: "BUY",
  ...overrides,
});

const coverage = (status: "partial" | "bounded_complete" | "unavailable" = "partial") => status === "unavailable" ? {
  status, coverageStartSignature: null, headSignature: null, backfillComplete: false,
  revision: null, updatedAt: null, fullHistory: false as const,
} : {
  status,
  coverageStartSignature: signatureB,
  headSignature: signatureC,
  backfillComplete: status === "bounded_complete",
  revision: 4,
  updatedAt: "2026-09-19T12:00:00.000Z",
  fullHistory: false as const,
};

const page = (items: readonly ChainTrade[] = [trade()], nextCursor: string | null = null,
  status: "partial" | "bounded_complete" | "unavailable" = "partial"): ChainTradePage => ({
  items, nextCursor,
  ordering: { direction: "desc", keys: ["slot", "signature", "logIndex"], semantics: "deterministic_journal_display_only" },
  coverage: coverage(status),
});

const state = (overrides: Partial<ChainTradeTapeState> = {}): ChainTradeTapeState => ({
  marketKey: "7:1000", requestId: 1, status: "ready", items: [trade()], nextCursor: null,
  coverage: coverage("partial"), seenCursors: [], failedCursor: null, error: null, ...overrides,
});

describe("chain trade tape response boundary", () => {
  it("preserves full-range bigint strings and formats probability without Number precision loss", () => {
    const parsed = parseChainTradePage(page(), "18446744073709551615");
    expect(parsed.items[0].makerOrderId).toBe("18446744073709551615");
    expect(parsed.items[0].quantity).toBe("9007199254740993");
    expect(formatImpliedProbability("9223372036854775808", "18446744073709551615")).toBe("50.00%");
    expect(formatImpliedProbability("1", "3")).toBe("33.33%");
  });

  it.each([
    { ...page(), extra: true },
    { ...page(), items: [{ ...trade(), timestamp: "invented" }] },
    { ...page(), items: [{ ...trade(), quantity: "1e3" }] },
    { ...page(), items: [{ ...trade(), yesPrice: "1001" }] },
    { ...page(), items: [{ ...trade(), signature: "not-base58" }] },
    { ...page(), ordering: { direction: "asc", keys: ["slot", "signature", "logIndex"], semantics: "deterministic_journal_display_only" } },
    { ...page(), coverage: { ...coverage(), fullHistory: true } },
  ])("fails closed on malformed or contradictory responses", (value) => {
    expect(() => parseChainTradePage(value, "1000")).toThrow();
  });

  it("deduplicates identical identities and rejects conflicting duplicate payloads", () => {
    expect(parseChainTradePage(page([trade(), trade()]), "1000").items).toHaveLength(1);
    expect(() => parseChainTradePage(page([trade(), trade({ quantity: "2" })]), "1000")).toThrow("Conflicting");
    expect(() => mergeChainTrades([trade()], [trade({ quantity: "2" })])).toThrow("Conflicting");
    expect(mergeChainTrades([trade()], [trade()])).toHaveLength(1);
  });
});

describe("chain trade tape requests and keyset pagination", () => {
  it("requests exactly 25 rows with no-store, same-origin credentials, and an encoded opaque cursor", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(page([], null, "unavailable")), {
      status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store" },
    }));
    const controller = new AbortController();
    await fetchChainTradePage("18446744073709551615", "abc_-123", "1000", controller.signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/solana/markets/18446744073709551615/trades?limit=25&cursor=abc_-123",
      expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal }),
    );
  });

  it("passes abort signals through and rejects non-JSON successes", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const pending = fetchChainTradePage("7", null, undefined, controller.signal, fetcher);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(fetchChainTradePage("7", null, undefined, new AbortController().signal,
      vi.fn(async () => new Response("ok", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } })))).rejects.toThrow("type");
    await expect(fetchChainTradePage("7", null, undefined, new AbortController().signal,
      vi.fn(async () => new Response(JSON.stringify(page()), { status: 200,
        headers: { "Content-Type": "application/json" } })))).rejects.toThrow("caching");
  });

  it("deduplicates keyset overlap, preserves order, and ignores stale market/request responses", () => {
    const first = trade();
    const second = trade({ signature: signatureB, logIndex: 1 });
    const current = state({ items: [first], nextCursor: "next", requestId: 9 });
    const merged = chainTradeTapeReducer(current, { type: "success", marketKey: current.marketKey, requestId: 9,
      cursor: "next", page: page([first, second], null) });
    expect(merged.items).toEqual([first, second]);
    const stale = chainTradeTapeReducer(merged, { type: "success", marketKey: current.marketKey, requestId: 8,
      cursor: null, page: page([trade({ signature: signatureC })]) });
    expect(stale).toBe(merged);
    expect(chainTradeTapeReducer(merged, { type: "success", marketKey: "8:1000", requestId: 9,
      cursor: null, page: page([trade({ signature: signatureC })]) })).toBe(merged);
  });

  it("fails closed on cyclic cursors and pagination that makes no deduplicated progress", () => {
    const twentyFive = Array.from({ length: 25 }, (_, index) => trade({ signature: `${index + 1}`.repeat(64).slice(0, 64), logIndex: index }));
    const current = state({ items: twentyFive, nextCursor: "cursor-b", requestId: 12, seenCursors: ["cursor-a"] });
    const cyclic = chainTradeTapeReducer(current, { type: "success", marketKey: current.marketKey, requestId: 12,
      cursor: "cursor-b", page: page([trade({ signature: signatureC })], "cursor-a") });
    expect(cyclic.status).toBe("error");
    const stalled = chainTradeTapeReducer(current, { type: "success", marketKey: current.marketKey, requestId: 12,
      cursor: "cursor-b", page: page(twentyFive, "cursor-c") });
    expect(stalled.status).toBe("error");
  });

  it("retains verified rows and failed cursor for a load-more retry", () => {
    const current = state({ requestId: 5, nextCursor: "next" });
    const failed = chainTradeTapeReducer(current, { type: "failure", marketKey: current.marketKey, requestId: 5, cursor: "next" });
    expect(failed.items).toEqual(current.items);
    expect(failed.failedCursor).toBe("next");
    expect(failed.status).toBe("error");
  });
});

describe("chain trade tape rendering", () => {
  const renderView = (value: ChainTradeTapeState, payoutMilli?: string, explorerCluster?: "devnet") => renderToStaticMarkup(
    React.createElement(ChainTradeTapeView, { state: value, payoutMilli, explorerCluster, onLoadMore: vi.fn(), onRetry: vi.fn() }),
  );

  it.each([
    ["partial", "Partial coverage"],
    ["bounded_complete", "Bounded window complete"],
    ["unavailable", "Coverage unavailable"],
  ] as const)("discloses %s coverage and never claims full history", (status, wording) => {
    const html = renderView(state({ coverage: coverage(status) }), "1000");
    expect(html).toContain(wording);
    expect(html).toContain("fullHistory: false");
  });

  it("renders actual discrete probabilities, both counterparties, exact slots, and no invented timestamps", () => {
    const html = renderView(state(), "3");
    expect(html).toContain("33.33%");
    expect(html).toContain("1/3 payout units");
    expect(html).toContain("SELL YES");
    expect(html).toContain("BUY YES");
    expect(html).toContain("18446744073709551615");
    expect(html).toContain("dots only, no interpolation");
    expect(html).not.toContain("2026-09-19T12:00:00.000Z");
    expect(html.toLowerCase()).not.toMatch(/createdat|executed at/);
    expect(html).not.toContain("<polyline");
    expect(html).not.toContain("<path");
  });

  it("only links signatures when a safe explicit explorer cluster is supplied", () => {
    expect(renderView(state(), "1000")).not.toContain("explorer.solana.com");
    const linked = renderView(state(), "1000", "devnet");
    expect(linked).toContain(`https://explorer.solana.com/tx/${signatureA}?cluster=devnet`);
    expect(linked).toContain('rel="noopener noreferrer"');
    expect(renderView(state(), "1000", "devnet&evil=1" as "devnet")).not.toContain("explorer.solana.com");
  });

  it("renders honest empty, loading, error/retry, and payout-unavailable states", () => {
    expect(renderView(state({ status: "loading", items: [], coverage: null }))).toContain("Loading verified finalized trades");
    expect(renderView(state({ items: [], coverage: coverage("bounded_complete") }))).toContain("does not prove that no trades occurred");
    const error = renderView(state({ status: "error", error: "Verified trade activity could not be loaded.", failedCursor: "next" }));
    expect(error).toContain('role="alert"'); expect(error).toContain("Retry");
    expect(renderView(state(), undefined)).toContain("Probability unavailable");
  });

  it("fails closed before fetching when component props are noncanonical", () => {
    const html = renderToStaticMarkup(React.createElement(ChainTradeTape, { marketId: "07", payoutMilli: "1000" }));
    expect(html).toContain("canonical market inputs are invalid");
  });
});
