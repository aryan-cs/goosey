import { describe, expect, it } from "vitest";
import { leaderboardPlayerHref } from "./leaderboard-search";

describe("leaderboard search navigation", () => {
  it("links a result to its ranked page and stable player anchor", () => {
    expect(leaderboardPlayerHref({ userId: "player/87", page: 2 })).toBe(
      "/leaderboard?page=2&focus=player%2F87#player-player%2F87",
    );
  });
});
