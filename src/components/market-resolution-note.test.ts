import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MARKET_RESOLUTION_NOTE, MarketResolutionNote } from "./market-resolution-note";

describe("MarketResolutionNote", () => {
  it("explains closing, valid fills, released reservations, and void payouts accurately", () => {
    const markup = renderToStaticMarkup(createElement(MarketResolutionNote));

    expect(markup).toContain("Trading after resolution");
    expect(MARKET_RESOLUTION_NOTE).toContain("Completed trades made before close remain valid");
    expect(MARKET_RESOLUTION_NOTE).toContain("submitted after close are not accepted");
    expect(MARKET_RESOLUTION_NOTE).toContain("unfilled order-book reservations are released");
    expect(MARKET_RESOLUTION_NOTE).toContain("pays 50% of the listed winner payout");
  });
});
