import selectedMarkets from "./selected-markets.json";

export interface HtnMarket {
  slug: string; title: string; shortTitle: string; description: string; rules: string;
  resolutionSource: string; category: string; icon: string; color: string; featured: boolean;
  closesAt: string; resolvesAt: string; openingProbability: number; pricingRationale: string;
}

export const htnMarkets: HtnMarket[] = selectedMarkets;
export const htnEvents = [{
  slug: "htn-2026-selected-finals", title: "Closing ceremony predictions",
  shortTitle: "Closing ceremony", description: "The current six-market selection.",
  category: "Hack the North", featured: true, color: "green", icon: "sparkles",
  startsAt: "2026-09-18T00:00:00-04:00", endsAt: "2026-09-20T16:30:00-04:00",
  marketSlugs: htnMarkets.map(m => m.slug),
}];
