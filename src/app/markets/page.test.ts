import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UnifiedDatabaseMarket, UnifiedSolanaMarket } from "@/lib/unified-market-repository";

const list = vi.hoisted(() => vi.fn());

vi.mock("@/lib/unified-market-repository", () => ({ unifiedMarketReadRepository: { list } }));
vi.mock("@/components/live-page-refresh", () => ({ LivePageRefresh: () => null }));

vi.mock("@/components/market", () => ({
  MarketListRow: ({ market }: { market: { slug: string; volume: string; sparkline?: unknown[] } }) =>
    React.createElement("article", {
      "data-row": market.slug,
      "data-volume": market.volume,
      "data-points": market.sparkline?.length ?? -1,
    }, React.createElement("a", { href: `/markets/${market.slug}` }, market.slug)),
}));

import MarketsPage, { solanaMarketSummary, sortBrowseMarkets } from "./page";

const now = new Date("2026-09-20T00:00:00.000Z");

function editorial(id: string, createdAt = now) {
  return { id, slug: id, title: id, shortTitle: id, description: id, rules: id,
    resolutionSource: id, category: "Campus", featured: false, color: "#000", icon: "G",
    createdAt, updatedAt: createdAt };
}

function solana(overrides: Partial<UnifiedSolanaMarket["financial"]> = {}): UnifiedSolanaMarket {
  return { executionBackend: "SOLANA", href: "/markets/finalized-market", editorial: editorial("finalized-market"), financial: {
    source: "solana-finalized", finalizedSlot: 9n, coverageRevision: 1, coverageUpdatedAt: now,
    marketAddress: "market", chainMarketId: 7n, payoutMilli: 1_000n, feeBps: 100,
    closesAt: new Date("2026-09-21T00:00:00.000Z"), resolvesAt: new Date("2026-09-22T00:00:00.000Z"),
    status: "OPEN", acceptingOrders: true, resolution: null, probabilityYesBps: 6_250,
    probabilitySource: "MID", bids: [], asks: [], traderCount: 2,
    recentTrades: [{ signature: "sig", slot: 8n, logIndex: 0, quantity: 500n, yesPriceMilli: 625n }],
    recentTradeWindowComplete: false, ...overrides,
  } };
}

function database(id: string, volumeMilli: bigint, createdAt = now, closesAt = new Date("2026-09-21T00:00:00.000Z")): UnifiedDatabaseMarket {
  const expired = closesAt <= now;
  const summary = { id, slug: id, title: id, category: "Campus", closesAt: expired ? "1 minute ago" : "in 1 day", status: expired ? "closed" as const : "open" as const,
    volume: Number(volumeMilli), outcomes: [{ id: "YES", label: "Yes", probability: 0.5 }], sparkline: [] };
  return { executionBackend: "DATABASE", href: `/markets/${id}`, editorial: editorial(id, createdAt), financial: {
    source: "database", market: { id, volumeMilli, closesAt } as never,
    mark: {} as never, summary,
  } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

describe("markets browse page", () => {
  it("maps finalized Solana state without inventing volume, movement, or history", () => {
    const summary = solanaMarketSummary(solana(), now);
    expect(summary).toMatchObject({ slug: "finalized-market", volume: "—", status: "open", sparkline: [],
      outcomes: [{ probability: 0.625 }, { probability: 0.375 }] });
    expect(summary.outcomes.every((outcome) => outcome.change === undefined)).toBe(true);
  });

  it("preserves database volume order and keeps unknown Solana volume honest", () => {
    expect(sortBrowseMarkets([solana(), database("low", 1n), database("high", 9n)], "trending")
      .map((market) => market.editorial.id)).toEqual(["high", "low", "finalized-market"]);
  });

  it("keeps live markets ahead of higher-volume closed markets in trending order", () => {
    expect(sortBrowseMarkets([
      database("closed-high", 100n, now, new Date("2026-09-19T23:59:00.000Z")),
      database("open-low", 1n),
    ], "trending").map((market) => market.editorial.id)).toEqual(["open-low", "closed-high"]);
  });

  it("passes filters and sort to the unified repository and renders one unbranded market list", async () => {
    list.mockResolvedValue([database("db-market", 4n), database("expired-market", 9n, now, new Date("2026-09-19T23:59:00.000Z")), solana()]);
    const html = renderToStaticMarkup(await MarketsPage({ searchParams: Promise.resolve({
      q: " goose ", category: "Campus", sort: "closing",
    }) }));

    expect(list).toHaveBeenCalledWith({ statuses: ["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOID"], category: "Campus", q: "goose", sort: "closing", limit: 100 });
    expect(html).toContain('class="market-list browse-list"');
    expect(html).toContain('data-row="db-market"');
    expect(html).toContain('data-row="expired-market"');
    expect(html).toContain('data-row="finalized-market"');
    expect(html).toContain('href="/markets/finalized-market"');
    expect(html).toContain('data-volume="—"');
    expect(html).toContain('data-points="0"');
    expect(html.toLowerCase()).not.toContain("solana");
    expect(html).not.toContain('href="/chain"');
  });
});
