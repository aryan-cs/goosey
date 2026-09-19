import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  index: 0,
  values: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: () => undefined,
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => ({ current: initial }),
    useState: <T,>(initial: T) => {
      const index = hooks.index++;
      return [index < hooks.values.length ? hooks.values[index] as T : initial, vi.fn()] as const;
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import React from "react";
import { TradeTicket, type TradePricing, type TradeQuote } from "./trade-ticket";

const quote = (overrides: Partial<TradeQuote> = {}): TradeQuote => ({
  quoteId: "quote_render_fixture",
  marketVersion: 7,
  quantity: 3,
  grossMilli: "191500",
  feeMilli: "2500",
  totalDebitMilli: "194000",
  averagePriceMilli: "63833",
  probabilityYesBeforeBps: 6100,
  probabilityYesAfterBps: 6400,
  payoutMilli: "100000",
  expiresAt: "2026-09-19T22:00:00.000Z",
  ...overrides,
});

function renderTicket(action: "BUY" | "SELL", tradeQuote: TradeQuote | null, state: "editing" | "review", preview: TradePricing | null = null) {
  hooks.index = 0;
  // Mirrors the component's state declarations: action, outcome, quantity,
  // quote, preview, preview lifecycle, trade lifecycle, then error.
  hooks.values = [action, "YES", 3, tradeQuote, preview, false, null, state, null];
  return renderToStaticMarkup(React.createElement(TradeTicket, {
    marketId: "render-fixture",
    marketTitle: "Will this rendering fixture resolve YES?",
    yesProbability: 0.61,
  }));
}

function breakdownValue(html: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<dt>${escaped}</dt><dd>([\\s\\S]*?)</dd>`));
  expect(match, `missing breakdown row: ${label}`).not.toBeNull();
  return match![1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

describe("trade ticket quote summary", () => {
  beforeEach(() => {
    hooks.index = 0;
    hooks.values = [];
  });

  it("shows the server-calculated buy cost, winning return, and profit before review", () => {
    const html = renderTicket("BUY", null, "editing", quote());

    expect(breakdownValue(html, "Current forecast")).toBe("61%");
    expect(breakdownValue(html, "Current cost")).toBe("194");
    expect(breakdownValue(html, "Total return if correct")).toBe("300");
    expect(breakdownValue(html, "Potential profit")).toBe("106");
    expect(html).toContain("Live preview based on the current market");
  });

  it("replaces estimates with exact quoted buy amounts during review", () => {
    const html = renderTicket("BUY", quote(), "review");

    expect(breakdownValue(html, "You pay now")).toBe("194");
    expect(breakdownValue(html, "Total return if correct")).toBe("300");
    expect(breakdownValue(html, "Profit if correct")).toBe("106");
    expect(breakdownValue(html, "Fee")).toBe("2.5");
    expect(html).toContain("Buy 3 YES");
  });

  it("shows server-calculated sell proceeds without implying the sold contracts can still win", () => {
    const preview = quote({
      grossMilli: "187000",
      feeMilli: "2000",
      totalDebitMilli: undefined,
      netCreditMilli: "185000",
      averagePriceMilli: "62333",
      probabilityYesAfterBps: 5800,
    });
    const html = renderTicket("SELL", null, "editing", preview);

    expect(breakdownValue(html, "Current forecast")).toBe("61%");
    expect(breakdownValue(html, "Current proceeds")).toBe("185");
    expect(html).not.toContain("Total return if correct");
    expect(html).not.toContain("Potential profit");
  });

  it("shows exact net sale proceeds during review", () => {
    const html = renderTicket("SELL", quote({
      grossMilli: "187000",
      feeMilli: "2000",
      totalDebitMilli: undefined,
      netCreditMilli: "185000",
      averagePriceMilli: "62333",
      probabilityYesAfterBps: 5800,
    }), "review");

    expect(breakdownValue(html, "You receive now")).toBe("185");
    expect(breakdownValue(html, "Fee")).toBe("2");
    expect(html).not.toContain("If correct, receive");
    expect(html).not.toContain("Net profit if correct");
    expect(html).toContain("Sell 3 YES");
  });
});
