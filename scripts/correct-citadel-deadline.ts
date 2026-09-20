/** One-time, exact production correction for the user-confirmed Citadel deadline. */
import { db, requireDatabaseStartup } from "../src/lib/db";
import { marketPublisher } from "./lib/market-publisher";

const MARKET_ID = "cmu8ulw23000kgm54pwyooyfw";
const MARKET_SLUG = "htn-2026-chinese-citadel-poker-winner";
const OLD_CLOSE = new Date("2026-09-20T00:29:00.000Z");
const CORRECT_CLOSE = new Date("2026-09-20T02:00:00.000Z");
const CONFIRMATION = "2026-09-19-citadel-closes-at-10pm";
const OLD_RULES = "Resolves YES if the winner of the Citadel Poker event at Hack the North 2026 self-identifies as Chinese. Otherwise, resolves NO.\n\nThe official Citadel Poker result determines the winner. Goosey moderators will not determine ethnicity based on names, appearance, vibes, poker ability, or questionable eyewitness testimony.\n\nIf the event is cancelled or no official winner is declared, the market is void.\n\nTrading closes at 8:29 p.m. EDT on Saturday, September 19, before the scheduled 8:30 p.m. start. Resolve when the official winner is announced; 10:00 p.m. is the scheduled event end, not evidence of a result.";
const CORRECT_RULES = "Resolves YES if the winner of the Citadel Poker event at Hack the North 2026 self-identifies as Chinese. Otherwise, resolves NO.\n\nThe official Citadel Poker result determines the winner. Goosey moderators will not determine ethnicity based on names, appearance, vibes, poker ability, or questionable eyewitness testimony.\n\nIf the event is cancelled or no official winner is declared, the market is void.\n\nTrading closes at 10:00 p.m. EDT on Saturday, September 19. Resolve when the official winner is announced.";

function fail(message: string): never { throw new Error(`Citadel deadline correction failed: ${message}`); }

async function main() {
  if (process.env.VERCEL_ENV !== "production" || process.env.APP_URL !== "https://getgoosey.vercel.app" || process.env.DATABASE_PROVIDER !== "postgresql" || process.env.NEON_PROJECT_ID !== "round-mud-98593510") fail("destination identity mismatch");
  if (process.env.GOOSEY_CORRECT_CITADEL_DEADLINE !== CONFIRMATION) fail("confirmation mismatch");
  await requireDatabaseStartup();
  const actor = await marketPublisher(db);
  const result = await db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT id FROM "Market" WHERE id = '${MARKET_ID}' FOR UPDATE`);
    const market = await tx.market.findUnique({ where: { id: MARKET_ID }, include: { _count: { select: { trades: true, positions: true, priceHistory: true } } } });
    if (!market || market.slug !== MARKET_SLUG || market.executionBackend !== "DATABASE") fail("market identity changed");
    if (market.closesAt.getTime() === CORRECT_CLOSE.getTime() && market.rules === CORRECT_RULES) return { alreadyCorrect: true, market };
    if (market.status !== "OPEN" || !market.acceptingOrders || market.version !== 36 || market.closesAt.getTime() !== OLD_CLOSE.getTime() || market.resolvesAt.getTime() !== CORRECT_CLOSE.getTime() || market.rules !== OLD_RULES) fail("reviewed market fields changed");
    const updated = await tx.market.update({
      where: { id: MARKET_ID },
      data: { closesAt: CORRECT_CLOSE, rules: CORRECT_RULES, version: { increment: 1 } },
      include: { _count: { select: { trades: true, positions: true, priceHistory: true } } },
    });
    await tx.auditLog.create({ data: {
      actorUserId: actor.id,
      action: "MARKET_DEADLINE_CORRECTED",
      entityType: "MARKET",
      entityId: MARKET_ID,
      metadata: JSON.stringify({ reason: "Owner confirmed Citadel trading closes at 10:00 p.m. Toronto time", before: { closesAt: OLD_CLOSE.toISOString(), rules: OLD_RULES }, after: { closesAt: CORRECT_CLOSE.toISOString(), rules: CORRECT_RULES }, preserved: market._count }),
    } });
    return { alreadyCorrect: false, market: updated };
  }, { isolationLevel: "Serializable", timeout: 30_000 });
  console.log(JSON.stringify({
    alreadyCorrect: result.alreadyCorrect,
    id: result.market.id,
    slug: result.market.slug,
    status: result.market.status,
    acceptingOrders: result.market.acceptingOrders,
    closesAt: result.market.closesAt,
    resolvesAt: result.market.resolvesAt,
    version: result.market.version,
    preserved: result.market._count,
  }));
}

main().finally(() => db.$disconnect());
