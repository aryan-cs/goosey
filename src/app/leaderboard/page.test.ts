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

vi.mock("./leaderboard-search", () => ({
  LeaderboardSearch: () => React.createElement("input", { placeholder: "Search people" }),
}));

vi.mock("@/components/data-primitives", () => ({
  LeaderboardPodium: ({ users }: { users: Array<{ id: string; rank: number }> }) => React.createElement(
    "div",
    { "data-testid": "podium", "data-ranks": users.map((user) => user.rank).join(",") },
    users.map((user) => React.createElement("div", { id: `player-${user.id}`, key: user.id })),
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

  it("makes the ranking summary locate the viewer and puts search in the old button position", async () => {
    mocks.getServerUser.mockResolvedValueOnce({ id: "player-53" });
    mocks.getLeaderboardPage.mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, index) => row(index + 1)),
      page: 1,
      totalPages: 2,
      total: 53,
      viewer: row(53),
    });

    const html = await render(1);
    const card = html.match(/<a[^>]*href="\/leaderboard\?page=2&amp;focus=player-53#player-player-53"[^>]*>([\s\S]*?)<\/a>/);

    expect(card).not.toBeNull();
    expect(card![1]).toContain("Your ranking");
    expect(card![1]).toContain("#53");
    expect(html).toContain('placeholder="Search people"');
    expect(html).not.toContain("Find me in the list");
  });

  it("links podium viewers to their podium anchor and paginated viewers to an existing row", async () => {
    mocks.getServerUser.mockResolvedValue({ id: "viewer" });
    mocks.getLeaderboardPage.mockResolvedValueOnce({
      rows: Array.from({ length: 50 }, (_, index) => row(index + 1)),
      page: 1,
      totalPages: 2,
      total: 53,
      viewer: row(2),
    });
    const podiumPage = await render(1);
    expect(podiumPage).toContain('href="/leaderboard?page=1&amp;focus=player-2#player-player-2"');
    expect(podiumPage).toContain('id="player-player-2"');

    mocks.getLeaderboardPage.mockResolvedValueOnce({
      rows: [row(51), row(52), row(53)],
      page: 2,
      totalPages: 2,
      total: 53,
      viewer: row(53),
    });
    const secondPage = await render(2);
    expect(secondPage).toContain('href="/leaderboard?page=2&amp;focus=player-53#player-player-53"');
    expect(secondPage).toContain('id="player-player-53"');
  });
});
