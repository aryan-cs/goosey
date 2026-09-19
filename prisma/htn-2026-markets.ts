import selectedMarkets from "./selected-markets.json";
import { DANCE_MARKET_GROUP, danceMarketDefinitions } from "../src/lib/dance-market";

export interface HtnMarket {
  slug: string; title: string; shortTitle: string; description: string; rules: string;
  resolutionSource: string; category: string; icon: string; color: string; featured: boolean;
  closesAt: string; resolvesAt: string; openingProbability: number; pricingRationale: string;
}

// Existing umbrella contracts remain in their database unchanged. Fresh seeds
// publish the first-dance group rather than recreating that older contract.
export const htnMarkets: HtnMarket[] = [
  ...selectedMarkets.filter(market => market.slug !== DANCE_MARKET_GROUP.legacyMarketSlug),
  ...danceMarketDefinitions,
];
export const htnEvents = [{
  slug: "htn-2026-selected-finals", title: "Hack the North 2026 predictions",
  shortTitle: "Hack the North 2026", description: "Predictions spanning side events, campus moments, judging, and the closing ceremony.",
  category: "Hack the North", featured: true, color: "green", icon: "sparkles",
  startsAt: "2026-09-18T00:00:00-04:00", endsAt: "2026-09-20T16:30:00-04:00",
  marketSlugs: selectedMarkets.filter(market => market.slug !== DANCE_MARKET_GROUP.legacyMarketSlug).map(m => m.slug),
}, {
  slug: DANCE_MARKET_GROUP.slug, title: DANCE_MARKET_GROUP.title,
  shortTitle: DANCE_MARKET_GROUP.shortTitle, description: DANCE_MARKET_GROUP.description,
  category: DANCE_MARKET_GROUP.category, featured: DANCE_MARKET_GROUP.featured,
  color: DANCE_MARKET_GROUP.color, icon: DANCE_MARKET_GROUP.icon,
  startsAt: DANCE_MARKET_GROUP.startsAt, endsAt: DANCE_MARKET_GROUP.endsAt,
  marketSlugs: danceMarketDefinitions.map(market => market.slug),
}];
