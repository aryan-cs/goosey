import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PageNavigation } from "./page-navigation";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
const render = (page: number, totalPages = 4) => renderToStaticMarkup(React.createElement(PageNavigation, { page, totalPages, href: (number: number) => `/leaderboard?page=${number}`, label: "Leaderboard pages" }));

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
    expect(html).not.toContain("disabled");
  });
  it("disables the final boundary and hides single-page navigation", () => {
    expect(render(4)).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Next page"/);
    expect(render(1, 1)).toBe("");
  });
});
