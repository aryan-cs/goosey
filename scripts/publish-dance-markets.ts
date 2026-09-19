import { parseArgs } from "node:util";
import { db, requireDatabaseStartup } from "../src/lib/db";
import { createAdminMarket, createMarketSchema, transitionAdminMarket } from "../src/lib/admin-service";
import { createAdminEvent, createEventSchema } from "../src/lib/event-service";
import { runSerializableTransaction } from "../src/lib/serializable-transaction";
import { DANCE_MARKET_GROUP, danceMarketDefinitions } from "../src/lib/dance-market";
import { marketPublisher } from "./lib/market-publisher";

const group = DANCE_MARKET_GROUP;
const eventInput = createEventSchema.parse({
  slug: group.slug, title: group.title, shortTitle: group.shortTitle, description: group.description,
  category: group.category, featured: group.featured, color: group.color, icon: group.icon,
  startsAt: group.startsAt, endsAt: group.endsAt,
});

async function legacyInspection() {
  return runSerializableTransaction(db, async tx => {
    const market = await tx.market.findUnique({
      where: { slug: group.legacyMarketSlug },
      include: {
        positions: { include: { user: { select: { role: true } } } },
        _count: { select: { trades: true, orders: true, orderFills: true, settlements: true, resolutionProposals: true } },
        settlementRun: { select: { id: true } },
      },
    });
    if (!market) return null;
    const hasActivity = Object.values(market._count).some(count => count > 0)
      || market.volumeMilli !== 0n || market.traderCount !== 0 || market.settlementRun !== null
      || market.resolution !== null || market.resolvedAt !== null
      || market.positions.some(position => position.user.role !== "SYSTEM" || position.netCostMilli !== 0n || position.yesCostBasisMilli !== 0n || position.noCostBasisMilli !== 0n || position.reservedYesShares !== 0 || position.reservedNoShares !== 0);
    return {
      id: market.id, status: market.status, version: market.version,
      // A trade changes an LMSR market version. The lifecycle service checks this
      // exact version again, so a concurrent trade prevents the retirement pause.
      mayPause: market.status === "OPEN" && market.pricingModel === "LMSR" && !hasActivity,
      hasActivity,
    };
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { username: { type: "string" }, "system-operator": { type: "boolean" }, apply: { type: "boolean" }, help: { type: "boolean" } },
    strict: true, allowPositionals: false,
  });
  if (values.help) {
    console.log("Usage: node --import tsx scripts/publish-dance-markets.ts (--username <existing-admin> | --system-operator) [--apply]\nDefault is a read-only preview. Publish four first-dance markets and pause only an untouched legacy LMSR umbrella market. System operator mode provisions the existing dedicated non-interactive publisher. No participant accounts are promoted and no existing contracts or balances are rewritten.");
    return;
  }
  if (positionals.length || Boolean(values.username) === Boolean(values["system-operator"])) throw new Error("Choose an exact existing administrator --username or --system-operator.");
  await requireDatabaseStartup();
  const selectedActor = values.username ? await db.user.findUnique({ where: { username: values.username }, select: { id: true, role: true, status: true } }) : null;
  if (values.username && (!selectedActor || selectedActor.role !== "ADMIN" || selectedActor.status !== "ACTIVE")) throw new Error("An active existing administrator is required; no account was changed.");
  let event = await db.marketEvent.findUnique({ where: { slug: group.slug } });
  if (event) {
    for (const [field, expected] of Object.entries(eventInput)) {
      const actual = event[field as keyof typeof event];
      if (actual instanceof Date && expected instanceof Date ? actual.getTime() !== expected.getTime() : actual !== expected) {
        throw new Error(`Existing first-dance event differs at ${field}; refusing to overwrite it.`);
      }
    }
  }
  const missing = [];
  for (const definition of danceMarketDefinitions) {
    const existing = await db.market.findUnique({ where: { slug: definition.slug } });
    if (!existing) {
      const { openingProbability, pricingRationale, ...editorial } = definition;
      void pricingRationale;
      if (openingProbability !== .5) throw new Error("Only neutral binary opening prices are supported.");
      // Validate every missing contract before the first mutation.
      missing.push(createMarketSchema.parse({ ...editorial, status: "OPEN", pricingModel: "LMSR", liquidityParameter: 40, payoutMilli: "100000", feeBps: 0 }));
      continue;
    }
    const textFields = ["title", "shortTitle", "description", "rules", "resolutionSource"] as const;
    if (textFields.some(field => existing[field] !== definition[field])
      || existing.closesAt.getTime() !== new Date(definition.closesAt).getTime()
      || existing.resolvesAt.getTime() !== new Date(definition.resolvesAt).getTime()
      || existing.eventId !== event?.id || existing.pricingModel !== "LMSR" || existing.payoutMilli !== 100_000n) {
      throw new Error(`Existing child contract differs: ${definition.slug}; refusing to overwrite it.`);
    }
  }
  const legacy = await legacyInspection();
  console.log(JSON.stringify({ mode: values.apply ? "apply" : "preview", event: group.slug, newMarkets: missing.map(market => market.slug), legacy }, null, 2));
  if (!values.apply) return;
  const actor = selectedActor ?? await marketPublisher(db);
  if (!event) {
    const result = await createAdminEvent({ actorUserId: actor.id, idempotencyKey: "first-dance-event-v1", event: eventInput });
    event = await db.marketEvent.findUniqueOrThrow({ where: { id: result.event.id } });
  }
  for (const market of missing) {
    const created = await createAdminMarket({ actorUserId: actor.id, idempotencyKey: `first-dance-v1-${market.slug}`, market: { ...market, eventId: event.id } });
    console.log(`Published ${created.market.slug}`);
  }
  if (legacy?.mayPause) {
    // No retry on a stale version: a participant may have traded since preview.
    await transitionAdminMarket({ actorUserId: actor.id, marketId: legacy.id, action: "PAUSE", expectedVersion: legacy.version, reason: "Untouched umbrella market superseded by the first-dance group; original contract and ledger remain intact." });
    console.log("Paused the untouched original market. Its contract and accounting records were retained.");
  } else if (legacy) {
    console.log("Original market retained unchanged. Any existing positions still settle under its original any-dance rules.");
  }
  console.log("First-dance publication complete. Each child remains an independent binary market; no trades, payouts, or balance edits were submitted.");
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });
