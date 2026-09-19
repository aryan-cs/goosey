/** Explicitly requested amendment of the existing ceremony market; no accounting writes. */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@goosey/postgresql-client";

const { values } = parseArgs({ options: { apply: { type: "boolean" } }, strict: true });
const url = process.env.POSTGRES_DATABASE_URL;
if (!url) throw new Error("Supply POSTGRES_DATABASE_URL privately.");
const destination = new URL(url);
if (destination.hostname !== "ep-wandering-rice-avd9eipi-pooler.c-11.us-east-1.aws.neon.tech" || destination.pathname !== "/neondb") {
  throw new Error("Unexpected destination; this amendment targets the reviewed production database only.");
}
const db = new PrismaClient({ datasourceUrl: url, log: [] });
const slug = "htn-2026-mc-does-67";
const action = "MC_TO_CLOSING_SPEAKER_AMENDED";
const catalog = JSON.parse(readFileSync(new URL("../prisma/selected-markets.json", import.meta.url), "utf8"));
const definition = catalog.find((market: { slug: string }) => market.slug === slug);
if (definition?.title !== "Will a closing ceremony speaker do a 67?") throw new Error("Unexpected catalog definition.");
const notice = "Market amendment — September 19, 2026: eligibility was expanded from the MC to any closing ceremony speaker, including an MC. Existing holdings, trades, and deadlines are unchanged; the updated rules below apply to this market.";

try {
  const result = await db.$transaction(async tx => {
    if (!values.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const market = await tx.market.findUniqueOrThrow({ where: { slug }, include: { _count: { select: { trades: true, positions: true, comments: true, priceHistory: true, resolutionProposals: true } } } });
    const prior = await tx.auditLog.findFirst({ where: { action, entityId: market.id } });
    if (prior) {
      if (market.title !== definition.title || market.rules !== definition.rules || !market.description.includes(notice)) throw new Error("Amendment audit exists but editorial fields differ.");
      return { state: "already_applied", slug, title: market.title };
    }
    if (market.title !== "Will the MC do a 67?" || market.status !== "OPEN" || market.pricingModel !== "LMSR" || market.resolution !== null || market._count.resolutionProposals !== 0 || market.closesAt <= new Date()) {
      throw new Error("Contract state changed; inspect before amendment.");
    }
    const before = { title: market.title, shortTitle: market.shortTitle, description: market.description, rules: market.rules, resolutionSource: market.resolutionSource };
    const after = { title: definition.title, shortTitle: definition.shortTitle, description: `${definition.description}\n\n${notice}`, rules: definition.rules, resolutionSource: definition.resolutionSource };
    if (!values.apply) return { state: "preview", slug, before, after, activity: market._count };
    const actor = await tx.user.findUniqueOrThrow({ where: { id: "goosey-market-publisher-v1" } });
    if (actor.role !== "ADMIN" || actor.status !== "ACTIVE") throw new Error("Invalid audit operator.");
    const updated = await tx.market.updateMany({ where: { id: market.id, version: market.version, status: "OPEN" }, data: { ...after, version: { increment: 1 } } });
    if (updated.count !== 1) throw new Error("Concurrent market change; amendment rolled back.");
    await tx.auditLog.create({ data: { actorUserId: actor.id, action, entityType: "MARKET", entityId: market.id, metadata: JSON.stringify({ reason: "Owner explicitly requested original MC market rename to closing ceremony speaker and consistent rules", before, after, participantNotice: notice, activityAtAmendment: market._count, preserved: "Market ID, slug, balances, holdings, trades, comments, probability history, prices and deadlines" }) } });
    return { state: "applied", slug, title: after.title, activity: market._count };
  }, { isolationLevel: "Serializable", timeout: 20000 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.$disconnect();
}
