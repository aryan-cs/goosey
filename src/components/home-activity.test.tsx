import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HomeActivity } from "./home-activity";

describe("HomeActivity", () => {
  it("shows a semantic relative timestamp before each market", () => {
    const html = renderToStaticMarkup(<HomeActivity now={new Date("2026-09-19T20:00:00.000Z")} trades={[{
      id: "trade-1",
      source: "LMSR",
      action: "BUY",
      side: "YES",
      quantity: 2,
      amountMilli: 116_107n,
      feeMilli: 0n,
      createdAt: new Date("2026-09-19T19:55:00.000Z"),
      user: { username: "bowenzhu", profilePublic: true },
      market: { slug: "gpt-wrapper", shortTitle: "Will a GPT wrapper win?" },
    }]} />);

    expect(html).toContain('<time');
    expect(html).toContain('datetime="2026-09-19T19:55:00.000Z"');
    expect(html).toContain('title="Sep 19, 2026, 7:55 p.m. UTC"');
    expect(html).toContain('>5 minutes ago</time>');
    expect(html.indexOf("5 minutes ago")).toBeLessThan(html.indexOf("Will a GPT wrapper win?"));
    expect(html).toContain("Bought");
    expect(html).toContain("116.107");
  });
});
