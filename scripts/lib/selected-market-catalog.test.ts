import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import selectedMarkets from "../../prisma/selected-markets.json";
import { createMarketSchema } from "../../src/lib/admin-service";

const expectedSlugs = [
  "htn-2026-white-member-winning-team",
  "htn-2026-mc-does-67",
  "htn-2026-all-waterloo-team-wins",
  "htn-2026-winner-stage-dance",
  "htn-2026-stage-job-request",
  "htn-2026-stage-selfie",
  "htn-2026-all-toronto-team-wins",
  "htn-2026-jesus-return",
  "htn-2026-chinese-citadel-poker-winner",
  "htn-2026-goose-incidents-1",
  "htn-2026-gpt-wrapper-winner",
];

describe("selected market catalog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00-04:00"));
  });

  afterEach(() => vi.useRealTimers());

  it("keeps the badge-safe append-only order and unique slugs", () => {
    const slugs = selectedMarkets.map((market) => market.slug);
    expect(slugs).toEqual(expectedSlugs);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("validates every market through the production publication schema", () => {
    for (const { openingProbability, pricingRationale, ...market } of selectedMarkets) {
      expect(openingProbability).toBe(0.5);
      expect(pricingRationale).toBeTruthy();
      expect(() => createMarketSchema.parse({
        ...market,
        status: "OPEN",
        pricingModel: "LMSR",
        liquidityParameter: 40,
        payoutMilli: "100000",
        feeBps: 0,
      })).not.toThrow();
    }
  });

  it("retains the supplied four-market contract and schedule", () => {
    const bySlug = new Map(selectedMarkets.map((market) => [market.slug, market]));
    expect(bySlug.get("htn-2026-jesus-return")).toMatchObject({
      title: "Will Jesus return at Hack the North?",
      closesAt: "2026-09-20T16:30:00-04:00",
      resolvesAt: "2026-09-20T16:30:00-04:00",
    });
    expect(bySlug.get("htn-2026-chinese-citadel-poker-winner")).toMatchObject({
      title: "Will a Chinese kid win Citadel Poker?",
      closesAt: "2026-09-19T22:00:00-04:00",
      resolvesAt: "2026-09-19T22:00:00-04:00",
    });
    expect(bySlug.get("htn-2026-goose-incidents-1")).toMatchObject({
      title: "Will there be a reported goose attack?",
      closesAt: "2026-09-20T16:30:00-04:00",
      resolvesAt: "2026-09-20T16:30:00-04:00",
    });
    expect(bySlug.get("htn-2026-gpt-wrapper-winner")).toMatchObject({
      title: "Will a GPT wrapper win?",
      closesAt: "2026-09-20T08:00:00-04:00",
      resolvesAt: "2026-09-20T16:30:00-04:00",
    });
  });
});
