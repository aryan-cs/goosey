import { describe, expect, it, vi } from "vitest";

const permanentRedirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ permanentRedirect }));

import ChainDirectory from "./page";
import ChainMarketPage from "./markets/[marketId]/page";
import ChainMarketReviewPage from "./markets/[marketId]/review/page";

describe("retired separate Solana market surfaces", () => {
  it.each([
    ["directory", () => ChainDirectory()],
    ["market", () => ChainMarketPage()],
    ["review", () => ChainMarketReviewPage()],
  ])("redirects the %s to the unified market directory", (_name, render) => {
    permanentRedirect.mockClear();
    render();
    expect(permanentRedirect).toHaveBeenCalledOnce();
    expect(permanentRedirect).toHaveBeenCalledWith("/markets");
  });
});
