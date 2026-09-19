import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLeaderboardPage: vi.fn(),
  getServerUser: vi.fn(),
}));

vi.mock("@/lib/leaderboard", () => ({
  getLeaderboardPage: mocks.getLeaderboardPage,
}));

// Some Next server modules eagerly traverse the session dependency graph while
// the page module loads. Keep this rendering test isolated from a real database.
vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/lib/server-session", () => ({
  getServerUser: mocks.getServerUser,
}));

vi.mock("@/components/live-page-refresh", () => ({
  LivePageRefresh: () => null,
}));

vi.mock("@/components/data-primitives", () => ({
  LeaderboardPodium: ({ users }: { users: Array<{ rank: number }> }) => React.createElement(
    "div",
    { "data-testid": "podium", "data-ranks": users.map((user) => user.rank).join(",") },
  ),
  LeaderboardRow: ({ user }: { user: { rank: number } }) => React.createElement(
    "div",
    { "data-testid": "leaderboard-row", "data-rank": user.rank },
  ),
}));

import LeaderboardPage from "./page";

function row(rank: number) {
  return {
    userId: `player-${rank}`,
    username: `player_${rank}`,
    displayName: `Player ${rank}`,
    profilePublic: true,
    equityMilli: BigInt((1_001 - rank) * 1_000),
    cashMilli: BigInt((1_001 - rank) * 1_000),
    marketsTraded: 0,
    rank,
  };
}

async function render(page: number) {
  return renderToStaticMarkup(await LeaderboardPage({
    searchParams: Promise.resolve({ page: String(page) }),
  }));
}

describe("leaderboard podium and paginated standings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerUser.mockResolvedValue(null);
    mocks.getLeaderboardPage.mockImplementation(async (page: number) => ({
      rows: page === 1
        ? Array.from({ length: 50 }, (_, index) => row(index + 1))
        : [row(51), row(52), row(53)],
      page,
      totalPages: 2,
      total: 53,
      viewer: null,
    }));
  });

  it("keeps the top three exclusively in the podium and starts the list at rank four", async () => {
    const html = await render(1);

    expect(html).toContain('data-testid="podium" data-ranks="1,2,3"');
    expect(html).not.toContain('data-testid="leaderboard-row" data-rank="1"');
    expect(html).not.toContain('data-testid="leaderboard-row" data-rank="2"');
    expect(html).not.toContain('data-testid="leaderboard-row" data-rank="3"');
    expect(html).toContain('data-testid="leaderboard-row" data-rank="4"');
    expect(html).toContain('data-testid="leaderboard-row" data-rank="50"');
    expect(html).toContain('href="/leaderboard?page=2"');
  });

  it("omits the podium after page one and preserves global ranks", async () => {
    const html = await render(2);

    expect(html).not.toContain('data-testid="podium"');
    expect(html).toContain('data-testid="leaderboard-row" data-rank="51"');
    expect(html).toContain('data-testid="leaderboard-row" data-rank="53"');
    expect(html).toContain('href="/leaderboard?page=1"');
  });

  it("renders a podium without an empty standings table when only three players exist", async () => {
    mocks.getLeaderboardPage.mockResolvedValueOnce({
      rows: [row(1), row(2), row(3)],
      page: 1,
      totalPages: 1,
      total: 3,
      viewer: null,
    });

    const html = await render(1);

    expect(html).toContain('data-testid="podium" data-ranks="1,2,3"');
    expect(html).not.toContain('aria-label="Leaderboard standings"');
  });
});
