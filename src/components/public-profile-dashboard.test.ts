import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PublicProfileDashboard } from "./public-profile-dashboard";

describe("PublicProfileDashboard", () => {
  it("renders trading metrics, an exact cash chart, and positions without private account fields", () => {
    const html = renderToStaticMarkup(React.createElement(PublicProfileDashboard, {
      identity: { username: "test20", displayName: "Test Twenty", bio: null, joinedAt: "2026-08-01T00:00:00.000Z" },
      summary: { equity: "1,234.50", pnl: "234.50", pnlPositive: true, volume: "900.00", trades: 12, marketsTraded: 4, availableCash: "734.50", reservedCash: "100.00", positionValue: "400.00" },
      positions: [{ id: "p:YES", marketSlug: "demo", marketTitle: "Will Goosey ship?", marketStatus: "OPEN", side: "YES", quantity: 10, averagePrice: 42, probability: 61, value: "610.00", pnl: "190.00", pnlPositive: true }],
      recentTrades: [],
      balanceSeries: [{ timestamp: "2026-08-01T00:00:00.000Z", value: 1000 }, { timestamp: "2026-09-01T00:00:00.000Z", value: 734.5 }],
      volumeSeries: [{ timestamp: "2026-09-01T00:00:00.000Z", value: 900 }],
      asOf: "2026-09-01T01:00:00.000Z",
    }));

    expect(html).toContain("@test20");
    expect(html).toContain('href="/users/test20"');
    expect(html).toContain("Portfolio value");
    expect(html).toContain("Available balance");
    expect(html).toContain('aria-label="Inspect available balance history"');
    expect(html).toContain('aria-label="Chart metric"');
    expect(html).toContain('aria-label="Chart range"');
    expect(html).toContain("Will Goosey ship?");
    expect(html).toContain('href="/markets/demo?outcome=YES"');
    expect(html).not.toContain(">Orders<");
    expect(html).not.toContain("email");
  });
});
