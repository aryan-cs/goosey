import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { UnifiedSolanaMarket } from "@/lib/unified-market-repository";

import { UnifiedSolanaMarketDetail } from "./unified-solana-market-detail";

function market(overrides: Partial<UnifiedSolanaMarket["financial"]> = {}): UnifiedSolanaMarket {
  return {
    executionBackend: "SOLANA",
    href: "/markets/will-goosey-ship",
    editorial: {
      id: "market-1",
      slug: "will-goosey-ship",
      title: "Will Goosey ship before the Hack the North closing ceremony?",
      shortTitle: "Will Goosey ship?",
      description: "This market tracks the public Goosey launch.",
      rules: "Resolve YES if the official project is live before the ceremony begins.",
      resolutionSource: "https://hackthenorth.com/results",
      category: "Hack the North",
      featured: true,
      color: "#f3c300",
      icon: "goose",
      createdAt: new Date("2026-09-18T12:00:00Z"),
      updatedAt: new Date("2026-09-19T12:00:00Z"),
    },
    financial: {
      source: "solana-finalized",
      finalizedSlot: 808n,
      coverageRevision: 2,
      coverageUpdatedAt: new Date("2026-09-19T12:00:00Z"),
      marketAddress: "MarketAddress",
      chainMarketId: 42n,
      payoutMilli: 1_000n,
      feeBps: 25,
      closesAt: new Date("2026-09-20T20:00:00Z"),
      resolvesAt: new Date("2026-09-21T02:00:00Z"),
      status: "OPEN",
      acceptingOrders: true,
      resolution: null,
      probabilityYesBps: 6_250,
      probabilitySource: "MID",
      bids: [{ priceMilli: 610n, quantity: 12n }, { priceMilli: 590n, quantity: 4n }],
      asks: [{ priceMilli: 640n, quantity: 8n }],
      traderCount: 17,
      recentTrades: [
        { signature: "signature-two", slot: 807n, logIndex: 1, quantity: 3n, yesPriceMilli: 625n },
        { signature: "signature-one", slot: 803n, logIndex: 0, quantity: 1n, yesPriceMilli: 600n },
      ],
      recentTradeWindowComplete: true,
      ...overrides,
    },
  };
}

describe("UnifiedSolanaMarketDetail", () => {
  it("renders the ordinary market surface entirely from supplied editorial and finalized financial data", () => {
    const html = renderToStaticMarkup(createElement(UnifiedSolanaMarketDetail, {
      market: market(),
      watchAction: createElement("button", { "aria-label": "Watch market" }, "Watch"),
      shareAction: createElement("button", { "aria-label": "Share market" }, "Share"),
    }));

    expect(html).toContain("Will Goosey ship before the Hack the North closing ceremony?");
    expect(html).toContain("YES 62.5%");
    expect(html).toContain("Order-book midpoint");
    expect(html).toContain("17 traders");
    expect(html).toContain("0.61");
    expect(html).toContain("12");
    expect(html).toContain("3 contracts");
    expect(html).toContain("Slot 807");
    expect(html).toContain("Resolve YES if the official project is live");
    expect(html).toContain("https://hackthenorth.com/results");
    expect(html).toContain("Watch market");
    expect(html).toContain("Share market");
  });

  it("has a neutral disabled trade state and no wallet or separate-chain language", () => {
    const html = renderToStaticMarkup(createElement(UnifiedSolanaMarketDetail, { market: market() }));

    expect(html).toContain("Order entry is temporarily unavailable while trading is being connected.");
    expect(html).toContain("Trading unavailable");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html).not.toMatch(/phantom|metamask|connect wallet|on-chain|chain market/i);
    expect(html).not.toContain("/chain");
  });

  it("renders honest empty states and a finalized resolution without inventing history", () => {
    const html = renderToStaticMarkup(createElement(UnifiedSolanaMarketDetail, {
      market: market({
        status: "RESOLVED",
        acceptingOrders: false,
        resolution: "YES",
        probabilityYesBps: 10_000,
        probabilitySource: "SETTLEMENT",
        bids: [],
        asks: [],
        recentTrades: [],
      }),
    }));

    expect(html).toContain("This market resolved YES.");
    expect(html).toContain("Final result");
    expect(html).toContain("No executions yet");
    expect(html.match(/No resting orders/g)).toHaveLength(2);
    expect(html).not.toContain("Slot 0");
  });

  it("does not turn a non-http resolution source into a link", () => {
    const supplied = market();
    const html = renderToStaticMarkup(createElement(UnifiedSolanaMarketDetail, {
      market: { ...supplied, editorial: { ...supplied.editorial, resolutionSource: "Hack the North judging desk" } },
    }));

    expect(html).toContain("Hack the North judging desk");
    expect(html).not.toContain("href=\"Hack the North judging desk\"");
  });
});
