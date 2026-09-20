import { describe, expect, it, vi } from "vitest";

const permanentRedirect = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ permanentRedirect }));

import ChainDirectory from "./page";
import ChainMarketPage from "./markets/[marketId]/page";
import ChainMarketReviewPage from "./markets/[marketId]/review/page";
import WalletPage from "../wallet/page";
import ChainLeaderboardPage from "../leaderboard/chain/page";

describe("retired separate Solana market surfaces", () => {
  it.each([
    ["directory", () => ChainDirectory(), "/markets"],
    ["market", () => ChainMarketPage(), "/markets"],
    ["review", () => ChainMarketReviewPage(), "/markets"],
    ["wallet", () => WalletPage(), "/portfolio"],
    ["chain leaderboard", () => ChainLeaderboardPage(), "/leaderboard"],
  ])("redirects the retired %s surface", (_name, render, destination) => {
    permanentRedirect.mockClear();
    render();
    expect(permanentRedirect).toHaveBeenCalledOnce();
    expect(permanentRedirect).toHaveBeenCalledWith(destination);
  });
});
