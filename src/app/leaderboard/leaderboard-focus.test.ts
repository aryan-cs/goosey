import { describe, expect, it, vi } from "vitest";
import { centerLeaderboardTarget } from "./leaderboard-focus";

describe("leaderboard viewer locator", () => {
  it("centers, focuses, and highlights the target", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const classes = new Set<string>();
    const player = {
      scrollIntoView,
      focus,
      classList: {
        add: (value: string) => classes.add(value),
        remove: (value: string) => classes.delete(value),
      },
      offsetWidth: 300,
    } as unknown as HTMLElement;

    centerLeaderboardTarget(player, false);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center", inline: "nearest" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(classes.size).toBe(1);

    centerLeaderboardTarget(player, true);
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "auto", block: "center", inline: "nearest" });
  });
});
