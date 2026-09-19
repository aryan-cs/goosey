/** Shared editorial contract for the four mutually exclusive first-dance markets. */
export const DANCE_MARKET_GROUP = {
  slug: "htn-2026-winner-first-dance",
  title: "Which dance will a winning team member do first?",
  shortTitle: "First victory dance",
  description: "Predict the first qualifying dance by an overall winning team member on the closing-ceremony stage: the worm, a dab, the floss, or none of these. Exactly one option wins if the evidence establishes an outcome. Each option has its own YES/NO market; quoted prices are independent and need not add up to 100%.",
  category: "Hack the North",
  color: "green",
  icon: "sparkles",
  featured: true,
  startsAt: "2026-09-18T00:00:00-04:00",
  endsAt: "2026-09-20T16:30:00-04:00",
  closesAt: "2026-09-20T14:30:00-04:00",
  resolvesAt: "2026-09-20T16:30:00-04:00",
  legacyMarketSlug: "htn-2026-winner-stage-dance",
} as const;

export const DANCE_RESOLUTION_SOURCE = "Full official closing-ceremony recording and official overall Hack the North 2026 winner list.";

const sharedRules = "Consider only listed members of officially announced overall Hack the North 2026 winning teams, physically on the official stage during closing ceremonies. Sponsor-only winners, audience members, offstage performances, and prerecorded footage do not qualify. A recognizable worm body-wave, dab pose, or floss movement qualifies. Identify the first qualifying dance by its onset in the full official recording, across all eligible people; later dances do not change the result. A performer need not have received their award yet, but must be confirmed on the overall winner list. Exactly one option resolves YES and the other three resolve NO. None of these wins only if complete usable evidence establishes that no qualifying dance occurred. If the event is canceled, winner eligibility cannot be established, the evidence is incomplete, or simultaneous qualifying dances cannot be ordered reliably, resolve all four markets VOID. Trading closes before closing ceremonies and must not reopen after the outcome is known.";

export const DANCE_MARKET_OUTCOMES = [
  { key: "WORM", slug: "htn-2026-winner-first-dance-worm", label: "Worm", title: "Will the worm be the first victory dance?", description: "YES if the first qualifying dance by an overall winning team member on the closing-ceremony stage is the worm. A later worm does not count.", rules: `YES if the first qualifying dance is the worm; NO if the first is a dab or the floss, or if none occurs. ${sharedRules}` },
  { key: "DAB", slug: "htn-2026-winner-first-dance-dab", label: "Dab", title: "Will a dab be the first victory dance?", description: "YES if the first qualifying dance by an overall winning team member on the closing-ceremony stage is a dab. A later dab does not count.", rules: `YES if the first qualifying dance is a dab; NO if the first is the worm or the floss, or if none occurs. ${sharedRules}` },
  { key: "FLOSS", slug: "htn-2026-winner-first-dance-floss", label: "Floss", title: "Will the floss be the first victory dance?", description: "YES if the first qualifying dance by an overall winning team member on the closing-ceremony stage is the floss. A later floss does not count.", rules: `YES if the first qualifying dance is the floss; NO if the first is the worm or a dab, or if none occurs. ${sharedRules}` },
  { key: "NONE", slug: "htn-2026-winner-first-dance-none", label: "None of these", title: "Will no winning team member do any of these dances?", description: "YES only if no overall winning team member performs the worm, a dab, or the floss on the closing-ceremony stage. Other dances do not count.", rules: `YES if no qualifying worm, dab, or floss occurs; NO if any qualifying dance occurs. ${sharedRules}` },
] as const;

export type DanceMarketOutcome = typeof DANCE_MARKET_OUTCOMES[number]["key"];
export const FIRST_DANCE_EVENT_SLUG = DANCE_MARKET_GROUP.slug;
export const FIRST_DANCE_OPTIONS = DANCE_MARKET_OUTCOMES;

export function isDanceMarketSlug(slug: string): boolean {
  return DANCE_MARKET_OUTCOMES.some(option => option.slug === slug);
}

export const danceMarketDefinitions = DANCE_MARKET_OUTCOMES.map(option => ({
  slug: option.slug, title: option.title, shortTitle: option.label,
  description: option.description, rules: option.rules, resolutionSource: DANCE_RESOLUTION_SOURCE,
  category: DANCE_MARKET_GROUP.category, icon: DANCE_MARKET_GROUP.icon, color: DANCE_MARKET_GROUP.color,
  featured: true, closesAt: DANCE_MARKET_GROUP.closesAt, resolvesAt: DANCE_MARKET_GROUP.resolvesAt,
  openingProbability: 0.5,
  pricingRationale: "Neutral binary starting price; not a normalized four-outcome forecast.",
}));
