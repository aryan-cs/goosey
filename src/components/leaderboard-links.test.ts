import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { LeaderboardPodium, LeaderboardRow } from "./data-primitives";

// Vitest's TSX transform uses React.createElement; Next supplies its JSX runtime.
vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const user = { id: "test-id", username: "public_goose", displayName: "Public Goose", rank: 1, score: 999.998 };

describe("leaderboard profile navigation", () => {
  it("links opted-in profiles from both the row and podium", () => {
    const visible = { ...user, profilePublic: true };
    for (const element of [React.createElement(LeaderboardRow, { user: visible }), React.createElement(LeaderboardPodium, { users: [visible] })]) {
      const html = renderToStaticMarkup(element);
      expect(html).toContain('href="/users/public_goose"');
      expect(html).toContain("1,000");
    }
  });
  it("shows the leaderboard total only once when an available balance is supplied", () => {
    const html = renderToStaticMarkup(React.createElement(LeaderboardRow, {
      user: { ...user, score: 1_426, availableBalance: 1_426 },
    }));
    expect(html).toContain("1,426");
    expect(html).not.toContain("available");
  });
  it("shows podium balances with only the feather icon and number", () => {
    const html = renderToStaticMarkup(React.createElement(LeaderboardPodium, { users: [user] }));
    expect(html).toContain("1,000");
    expect(html).not.toContain("Total ·");
  });
  it("gives every podium place a stable leaderboard anchor regardless of profile visibility", () => {
    const users = [
      { ...user, id: "first", rank: 1, profilePublic: true },
      { ...user, id: "second", rank: 2, profilePublic: false },
      { ...user, id: "third", rank: 3, profilePublic: undefined },
    ];
    const html = renderToStaticMarkup(React.createElement(LeaderboardPodium, { users }));
    expect(html).toContain('id="player-first"');
    expect(html).toContain('id="player-second"');
    expect(html).toContain('id="player-third"');
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });
  it("keeps private players visible without a link to an unavailable profile", () => {
    for (const profilePublic of [false, undefined]) {
      const privateUser = { ...user, profilePublic };
      for (const element of [React.createElement(LeaderboardRow, { user: privateUser }), React.createElement(LeaderboardPodium, { users: [privateUser] })]) {
        const html = renderToStaticMarkup(element);
        expect(html).toContain("Public Goose");
        expect(html).not.toContain("href=");
        expect(html).not.toContain("View Public Goose's profile");
      }
    }
  });
});
