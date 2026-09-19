import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortfolioSwitcher, portfolioViewDirection, type PortfolioView } from "./portfolio-switcher";

const render = (view: PortfolioView) => renderToStaticMarkup(React.createElement(
  PortfolioSwitcher,
  { view } as React.ComponentProps<typeof PortfolioSwitcher>,
  React.createElement("section", null, `${view} content`),
));

describe("PortfolioSwitcher", () => {
  it.each([
    ["positions", "/portfolio?view=positions"],
    ["orders", "/portfolio?view=orders"],
    ["history", "/portfolio?view=history"],
  ] as const)("marks only %s active and keeps every view directly linkable", (active, href) => {
    const html = render(active);

    expect(html).toContain('aria-label="Portfolio views"');
    expect(html).toContain('href="/portfolio?view=positions"');
    expect(html).toContain('href="/portfolio?view=orders"');
    expect(html).toContain('href="/portfolio?view=history"');
    const escapedHref = href.replace(/[?]/g, "\\?");
    expect(html).toMatch(new RegExp(`<a(?=[^>]*href="${escapedHref}")(?=[^>]*aria-current="page")[^>]*>`));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`${active} content`);
  });

  it("maps ordered view changes to consistent animation directions", () => {
    expect(portfolioViewDirection("positions", "orders")).toBe(1);
    expect(portfolioViewDirection("positions", "history")).toBe(1);
    expect(portfolioViewDirection("orders", "history")).toBe(1);
    expect(portfolioViewDirection("history", "orders")).toBe(-1);
    expect(portfolioViewDirection("history", "positions")).toBe(-1);
    expect(portfolioViewDirection("orders", "positions")).toBe(-1);
    for (const view of ["positions", "orders", "history"] as const) {
      expect(portfolioViewDirection(view, view)).toBe(0);
    }
  });

  it("keeps reduced-motion users free of indicator transitions and panel animation", () => {
    const css = readFileSync(new URL("./portfolio.module.css", import.meta.url), "utf8").replace(/\s+/g, " ");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const reducedMotion = start >= 0 ? css.slice(start, start + 240) : "";

    expect(reducedMotion).toContain(".tabIndicator { transition: none;");
    expect(reducedMotion).toContain(".viewPanelForward, .viewPanelBackward { animation: none;");
  });
});
