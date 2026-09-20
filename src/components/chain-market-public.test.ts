import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChainMarketView } from "@/lib/solana/market-view";
import type { SolanaRuntime } from "@/lib/solana/runtime";

vi.mock("./chain-trade-tape", () => ({
  ChainTradeTape: ({ marketId, payoutMilli }: { marketId: string; payoutMilli: string }) =>
    createElement("section", { "data-testid": "trade-tape" }, `Verified trades ${marketId} ${payoutMilli}`),
}));

import { VerifiedMarketOverview } from "./chain-market";

const runtime = {
  cluster: "localnet",
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q",
  rpcUrl: "http://127.0.0.1:20999",
} as SolanaRuntime;

const view = {
  digest: "ab".repeat(32),
  snapshot: {
    finalizedSlot: 321n,
    resolution: { phase: 0 },
    marketState: { closesAt: 2_000_000_000n, payoutMilli: 1_000n },
    orderBook: {
      bids: [{ id: 7n, canonicalYesPrice: 620n, remaining: 4n }],
      asks: [{ id: 8n, canonicalYesPrice: 680n, remaining: 2n }],
    },
  },
  terms: {
    rules: { yes: "The official result is yes.", no: "The official result is no.", void: "The source cannot resolve it." },
    sources: [{ id: "official", uri: "https://example.com/results", selection: "Published final result" }],
    sourcePolicy: { missing: "Wait for the source.", revisions: "Use the final revision." },
    observation: { startsAt: "1900000000", endsAt: "2000000000" },
  },
} as unknown as ChainMarketView;

describe("public verified chain-market overview", () => {
  it("renders finalized status, real book levels, committed rules, and trade tape without wallet data", () => {
    const html = renderToStaticMarkup(createElement(VerifiedMarketOverview, { view, marketId: 42n, runtime }));

    expect(html).toContain("Open · Closes");
    expect(html).toContain("Finalized on localnet at slot 321");
    expect(html).toContain("0.62");
    expect(html).toContain("0.68");
    expect(html).toContain("The official result is yes.");
    expect(html).toContain("https://example.com/results");
    expect(html).toContain("Verified trades 42 1000");
    expect(html).not.toContain("Your positions");
    expect(html).not.toContain("Available feathers");
  });
});
