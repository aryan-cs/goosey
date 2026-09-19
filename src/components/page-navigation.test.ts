import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PageNavigation } from "./page-navigation";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const render = (page: number, totalPages = 4, totalResults = 200, visibleResults = 50) => renderToStaticMarkup(React.createElement(PageNavigation, { page, totalPages, totalResults, pageSize: 50, visibleResults, href: (number: number) => `/leaderboard?page=${number}`, label: "Leaderboard pages" }));

describe("page navigation", () => {
  it("keeps both controls visible and disables the first boundary", () => {
    const html = render(1);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Previous page"/);
    expect(html).toContain('href="/leaderboard?page=2"');
    expect(html).not.toContain("page=0");
  });
  it("links in both directions on a middle page", () => {
    const html = render(2);
    expect(html).toContain('href="/leaderboard?page=1"');
    expect(html).toContain('href="/leaderboard?page=3"');
    expect(html).toContain("51–100");
    expect(html).toContain("of 200");
    expect(html).toContain("Page 2 of 4");
    expect(html).not.toContain("disabled");
  });
  it("disables the final boundary and shows the final partial range", () => {
    expect(render(4, 4, 176, 26)).toContain("151–176");
    expect(render(4)).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Next page"/);
  });
  it("shows the count on a single page and hides navigation when empty", () => {
    const html = render(1, 1, 24, 24);
    expect(html).toContain("1–24");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(render(1, 1, 0, 0)).toBe("");
  });
});
