/** Fictional development scenarios. This module plans trades; it never inserts chart data. */
export type DevelopmentMarketStatus = "OPEN" | "PAUSED" | "CLOSED" | "RESOLVED" | "VOID" | "DRAFT";
export type DevelopmentOutcome = "YES" | "NO" | "VOID";

export interface DevelopmentTradeIntent {
  at: Date;
  targetProbability: number;
  participantIndex: number;
  maxQuantity: number;
}

export interface DevelopmentEventScenario {
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  category: string;
  icon: string;
  color: string;
  featured: boolean;
  startsAt: Date;
  endsAt: Date;
}

export interface DevelopmentMarketScenario {
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  rules: string;
  resolutionSource: string;
  category: string;
  icon: string;
  color: string;
  featured: boolean;
  eventSlug: string;
  openedAt: Date;
  closesAt: Date;
  resolvesAt: Date;
  resolvedAt: Date | null;
  finalStatus: DevelopmentMarketStatus;
  resolution: DevelopmentOutcome | null;
  openingProbability: number;
  tradeIntents: DevelopmentTradeIntent[];
}

export interface DevelopmentScenarioPlan {
  asOf: Date;
  seed: number;
  events: DevelopmentEventScenario[];
  markets: DevelopmentMarketScenario[];
}

type Anchor = readonly [fraction: number, probability: number];
interface Definition {
  slug: string;
  title: string;
  shortTitle: string;
  category: string;
  event: number;
  openedDaysAgo: number;
  closeDaysFromNow: number;
  status: DevelopmentMarketStatus;
  outcome?: DevelopmentOutcome;
  anchors: readonly Anchor[];
  jump: number;
}

const DAY = 86_400_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DEVELOPMENT_LABEL = "Fictional development simulation; not an actual event or prediction.";

const DEFINITIONS: readonly Definition[] = [
  { slug: "solar-rover-demo", title: "Will the solar rover complete the fictional demo course?", shortTitle: "Solar rover finishes", category: "Projects", event: 0, openedDaysAgo: 90, closeDaysFromNow: 3, status: "OPEN", anchors: [[0, .28], [.3, .46], [.55, .38], [.8, .69], [1, .77]], jump: .07 },
  { slug: "midnight-noodle-vote", title: "Will noodles win the fictional midnight snack vote?", shortTitle: "Noodles win snack vote", category: "Food", event: 0, openedDaysAgo: 60, closeDaysFromNow: 2, status: "OPEN", anchors: [[0, .58], [.3, .41], [.55, .64], [.8, .53], [1, .62]], jump: -.08 },
  { slug: "rain-free-showcase", title: "Will the fictional outdoor showcase stay rain-free?", shortTitle: "Rain-free showcase", category: "Weather", event: 0, openedDaysAgo: 30, closeDaysFromNow: 1, status: "OPEN", anchors: [[0, .73], [.3, .66], [.55, .34], [.8, .42], [1, .29]], jump: -.11 },
  { slug: "accessible-demo-award", title: "Will an accessibility project win the fictional demo award?", shortTitle: "Accessibility wins", category: "Hack the North", event: 0, openedDaysAgo: 84, closeDaysFromNow: 4, status: "OPEN", anchors: [[0, .19], [.3, .29], [.55, .57], [.8, .49], [1, .71]], jump: .09 },
  { slug: "goose-relay-record", title: "Will the fictional campus relay finish under twelve minutes?", shortTitle: "Relay under 12 minutes", category: "Sports", event: 0, openedDaysAgo: 45, closeDaysFromNow: 5, status: "OPEN", anchors: [[0, .47], [.3, .53], [.55, .45], [.8, .56], [1, .48]], jump: .035 },
  { slug: "library-robot-delivery", title: "Will the fictional library robot deliver all ten books?", shortTitle: "Robot delivers ten books", category: "Tech", event: 0, openedDaysAgo: 72, closeDaysFromNow: 2, status: "PAUSED", anchors: [[0, .62], [.3, .74], [.55, .59], [.8, .36], [1, .43]], jump: -.10 },
  { slug: "workshop-capacity", title: "Did the fictional circuits workshop fill all forty seats?", shortTitle: "Circuits workshop fills", category: "Workshops", event: 1, openedDaysAgo: 70, closeDaysFromNow: -.5, status: "CLOSED", anchors: [[0, .35], [.3, .49], [.55, .61], [.8, .79], [1, .87]], jump: .06 },
  { slug: "campus-night-walk", title: "Did fifty people finish the fictional campus night walk?", shortTitle: "Fifty finish night walk", category: "Campus", event: 1, openedDaysAgo: 50, closeDaysFromNow: -.25, status: "CLOSED", anchors: [[0, .68], [.3, .54], [.55, .48], [.8, .29], [1, .17]], jump: -.075 },
  { slug: "waterloo-puzzle-sprint", title: "Was the fictional Waterloo puzzle sprint solved in an hour?", shortTitle: "Puzzle solved in an hour", category: "Waterloo", event: 2, openedDaysAgo: 90, closeDaysFromNow: -14, status: "RESOLVED", outcome: "YES", anchors: [[0, .32], [.3, .39], [.55, .64], [.8, .78], [1, .95]], jump: .08 },
  { slug: "mascot-caption-contest", title: "Did the fictional goose caption receive two hundred votes?", shortTitle: "Goose caption gets 200 votes", category: "Memes", event: 2, openedDaysAgo: 80, closeDaysFromNow: -7, status: "RESOLVED", outcome: "NO", anchors: [[0, .72], [.3, .64], [.55, .44], [.8, .21], [1, .07]], jump: -.09 },
  { slug: "courtyard-light-show", title: "Did the fictional courtyard light show begin before sunset?", shortTitle: "Light show before sunset", category: "Trending", event: 2, openedDaysAgo: 65, closeDaysFromNow: -3, status: "VOID", outcome: "VOID", anchors: [[0, .44], [.3, .58], [.55, .49], [.8, .61], [1, .52]], jump: .05 },
  { slug: "repair-cafe-launch", title: "Will the fictional repair cafe fix twenty devices?", shortTitle: "Repair cafe fixes 20", category: "Projects", event: 0, openedDaysAgo: 1, closeDaysFromNow: 8, status: "DRAFT", anchors: [[0, .5], [1, .5]], jump: 0 },
];

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function interpolate(anchors: readonly Anchor[], fraction: number): number {
  for (let index = 1; index < anchors.length; index += 1) {
    const left = anchors[index - 1];
    const right = anchors[index];
    if (fraction <= right[0]) {
      const progress = Math.max(0, (fraction - left[0]) / (right[0] - left[0]));
      const smooth = progress * progress * (3 - 2 * progress);
      return left[1] + (right[1] - left[1]) * smooth;
    }
  }
  return anchors[anchors.length - 1][1];
}

function tradeIntents(definition: Definition, openedAt: Date, closesAt: Date, asOf: Date, seed: number): DevelopmentTradeIntent[] {
  if (definition.status === "DRAFT") return [];
  const random = randomGenerator(seed);
  const start = openedAt.getTime();
  // Paused markets have no activity after their pause, even though close is still ahead.
  const end = Math.min(closesAt.getTime() - MINUTE, asOf.getTime() - (definition.status === "PAUSED" ? 2 * HOUR : MINUTE));
  const times = new Set<number>();
  const addRange = (from: number, until: number, step: number) => {
    for (let at = Math.max(start + MINUTE, from); at <= until; at += step) {
      const fraction = (at - start) / (end - start);
      // Two quiet spells on older portions of the path, leaving the recent window dense.
      if (at < end - 7 * DAY && ((fraction > .23 && fraction < .27) || (fraction > .61 && fraction < .65))) continue;
      const jitter = Math.floor(random() * Math.min(step / 3, 10 * MINUTE));
      if (at + jitter <= end) times.add(at + jitter);
    }
  };
  addRange(start + HOUR, end - 7 * DAY, DAY);
  addRange(end - 7 * DAY, end - DAY, 6 * HOUR);
  addRange(end - DAY, end - 6 * HOUR, 30 * MINUTE);
  addRange(end - 6 * HOUR, end - HOUR, 5 * MINUTE);
  addRange(end - HOUR, end, MINUTE);
  times.add(end);
  let noise = 0;
  return [...times].sort((a, b) => a - b).map((at) => {
    const fraction = (at - start) / (end - start);
    noise = noise * .8 + (random() - .5) * .014;
    // A discrete fictional information shock slowly decays into the prevailing trend.
    const shock = fraction >= .52 ? definition.jump * Math.exp(-(fraction - .52) * 9) : 0;
    const shortSwing = .016 * Math.sin((at - end) / (2.3 * HOUR) + seed % 17);
    const probability = interpolate(definition.anchors, fraction) + noise + shock + shortSwing;
    return {
      at: new Date(at),
      targetProbability: Math.round(Math.min(.97, Math.max(.03, probability)) * 10_000) / 10_000,
      participantIndex: Math.floor(random() * 24),
      maxQuantity: 2 + Math.floor(random() * 19),
    };
  });
}

/** Reproducible for a given anchor and seed; all timestamps are absolute UTC instants. */
export function buildDevelopmentScenarios(input: { asOf: Date; seed?: number }): DevelopmentScenarioPlan {
  if (!Number.isFinite(input.asOf.getTime())) throw new Error("Development scenarios require a valid asOf date.");
  const seed = input.seed ?? 20260919;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Development scenario seed must be an unsigned 32-bit integer.");
  const asOf = new Date(input.asOf);
  const date = (days: number) => new Date(asOf.getTime() + days * DAY);
  const eventDefinitions = [
    { slug: "dev-future-makers-festival", title: "Fictional Future Makers Festival", shortTitle: "Future Makers", category: "Hack the North", color: "green", icon: "sparkles", start: -90, end: 9 },
    { slug: "dev-campus-after-dark", title: "Fictional Campus After Dark", shortTitle: "Campus After Dark", category: "Campus", color: "blue", icon: "moon", start: -70, end: 1 },
    { slug: "dev-summer-community-series", title: "Fictional Summer Community Series", shortTitle: "Summer Community", category: "Waterloo", color: "gold", icon: "sun", start: -90, end: -1 },
  ];
  const events: DevelopmentEventScenario[] = eventDefinitions.map((event) => ({
    slug: event.slug, title: event.title, shortTitle: event.shortTitle,
    description: DEVELOPMENT_LABEL, category: event.category, color: event.color, icon: event.icon,
    featured: event.start === -90, startsAt: date(event.start), endsAt: date(event.end),
  }));
  const markets = DEFINITIONS.map((definition, index): DevelopmentMarketScenario => {
    const openedAt = date(-definition.openedDaysAgo);
    const closesAt = date(definition.closeDaysFromNow);
    const resolvesAt = date(definition.closeDaysFromNow + 1);
    const terminal = definition.status === "RESOLVED" || definition.status === "VOID";
    return {
      slug: `dev-${definition.slug}`, title: definition.title, shortTitle: definition.shortTitle,
      description: `${DEVELOPMENT_LABEL} Price movement represents simulated participant trades and fictional updates.`,
      rules: `${DEVELOPMENT_LABEL} Resolve YES only if the stated fictional threshold is met by close; otherwise NO. Void if the simulated event is canceled or evidence is unavailable.`,
      resolutionSource: "Local development scenario record; no real-world result is asserted.",
      category: definition.category, icon: events[definition.event].icon, color: events[definition.event].color,
      featured: index < 4, eventSlug: events[definition.event].slug,
      openedAt, closesAt, resolvesAt, resolvedAt: terminal ? new Date(resolvesAt) : null,
      finalStatus: definition.status, resolution: definition.outcome ?? null,
      openingProbability: definition.anchors[0][1],
      tradeIntents: tradeIntents(definition, openedAt, closesAt, asOf, (seed + index * 104729) >>> 0),
    };
  });
  return { asOf, seed, events, markets };
}
