import { describe, expect, it } from 'vitest';
import { createMarketSchema } from './admin-service';
import { createEventSchema } from './event-service';
import { isDanceMarketSlug } from './dance-market';
import { SEPTEMBER_MARKETS, INDEPENDENT_DANCE_GROUP, INDEPENDENT_DANCE_MARKETS } from './september-market-additions';

describe('September publication contracts', () => {
  it('validates all seven new contracts and their event before publication', () => {
    expect(createEventSchema.safeParse(INDEPENDENT_DANCE_GROUP).success).toBe(true);
    const definitions=[...SEPTEMBER_MARKETS,...INDEPENDENT_DANCE_MARKETS.map(({label,...market})=>{void label;return market;})];
    expect(new Set(definitions.map(x=>x.slug)).size).toBe(7);
    for(const definition of definitions) expect(createMarketSchema.safeParse({...definition,status:'DRAFT',pricingModel:'LMSR',liquidityParameter:40,payoutMilli:'100000',feeBps:0}).success).toBe(true);
  });
  it('keeps independently resolvable dance contracts outside the old mutually exclusive group', () => {
    expect(INDEPENDENT_DANCE_MARKETS).toHaveLength(3);
    for(const market of INDEPENDENT_DANCE_MARKETS) {
      expect(isDanceMarketSlug(market.slug)).toBe(false);
      expect(market.rules).toContain('multiple dances can resolve YES');
    }
  });
  it('closes poker before its Saturday start and GPT before Sunday judging in EDT', () => {
    const poker=SEPTEMBER_MARKETS.find(x=>x.slug.includes('poker'))!;
    const gpt=SEPTEMBER_MARKETS.find(x=>x.slug.includes('gpt'))!;
    expect(new Date(poker.closesAt).toISOString()).toBe('2026-09-20T00:29:00.000Z');
    expect(new Date(gpt.closesAt).toISOString()).toBe('2026-09-20T13:29:00.000Z');
    expect(gpt.rules).toContain('not when finalists are selected');
  });
});
