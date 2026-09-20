/**
 * Exact post-incident verifier for the September 19 Toronto-market Sybil attack.
 *
 * Preview is read-only. Apply only removes outstanding quotes for the affected
 * market: replaying the market invalidated every pre-cleanup quote, regardless
 * of which user requested it. No other production rows are mutated here.
 */
import { Prisma } from "@prisma/client";
import { db, requireDatabaseStartup } from "../src/lib/db";

const MARKET_ID = "cmu8tqf120002gm6k0gw5vxgl";
const MARKET_SLUG = "htn-2026-all-toronto-team-wins";
const APPLY_CONFIRMATION = "2026-09-20-verify-bot-cleanup-derived-state";
const EXPECTED_VOLUME_MILLI = 1_167_170n;
const EXPECTED_MARKET = { yesShares: 14, noShares: 7, traderCount: 5, probabilityYesBps: 5_436 };
const TARGET_IDS = [
  "cmu8wfl20000lic040xxx0dfm", "cmu8wrrxa000blb044szi94ys", "cmu8wtzsh002tjs04uk8vg2rh",
  "cmu8wudi3001jla04g3fbsukp", "cmu8wumg5000ul004vla4vs3s", "cmu8wuves002ylj04issdlei0",
  "cmu918w5e0000l404j96rh1ls", "cmu91alg3000jjo044ffxfe0h", "cmu91awly000sl404tp1v71mw",
  "cmu91b31b000wjp04ctis8wuk", "cmu91b8ri0017jp04v2peulaj", "cmu8x1uqv0029kz048b1mx28n",
  "cmu8x55c30000k104gs9krc7o", "cmu8x6qu50002l304cegd4xe6", "cmu8x71o4000dl304tyziwvhl",
  "cmu8x7yqb0027k104zn2kxwxa", "cmu91uay30000kx04jul0y5gf", "cmu91xtsb0000l504ny7nc28q",
  "cmu8wmj39001wlj04fv4b75dg",
] as const;
const TARGET_NAMES = [
  "test1", "test11", "test12", "test13", "test14", "test15", "test16", "test17", "test18", "test19", "test20",
  "asdf11", "asdf12", "asdf13", "asdf14", "asdf15", "asdf16", "asdf17", "arsonistduck",
] as const;
const EXPECTED_TRADES = new Map([
  ["cmu8ukljz000ijp04qeq08vik", { username: "alishaarora", side: "NO", action: "BUY", quantity: 1, amountMilli: 50_313n, priceAfterBps: 4_938 }],
  ["cmu8wf4ac0025jv04oubuplse", { username: "lucky_ducky037", side: "NO", action: "BUY", quantity: 1, amountMilli: 50_938n, priceAfterBps: 4_875 }],
  ["cmu8wofsj003zjv04a5oruhta", { username: "lucky_ducky037", side: "NO", action: "SELL", quantity: 1, amountMilli: 50_937n, priceAfterBps: 4_938 }],
  ["cmu8x0pwh004qjj04rp5qza0m", { username: "nomitchell", side: "YES", action: "BUY", quantity: 3, amountMilli: 150_938n, priceAfterBps: 5_125 }],
  ["cmu8x24fu002pl304zvmk9bbj", { username: "nomitchell", side: "YES", action: "BUY", quantity: 10, amountMilli: 543_583n, priceAfterBps: 5_744 }],
  ["cmu8x60m8001ck104ha7wq0d9", { username: "nomitchell", side: "YES", action: "BUY", quantity: 1, amountMilli: 57_750n, priceAfterBps: 5_805 }],
  ["cmu8y2mgs001ul304r2wp3t2e", { username: "williusmcphillius", side: "NO", action: "BUY", quantity: 1, amountMilli: 42_251n, priceAfterBps: 5_744 }],
  ["cmu92dq490007l804469metcr", { username: "sschemist", side: "NO", action: "BUY", quantity: 5, amountMilli: 220_460n, priceAfterBps: 5_436 }],
]);

function fail(message: string): never { throw new Error(`Bot cleanup verification failed: ${message}`); }
function json(value: unknown) { return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item); }

async function verify(tx: Prisma.TransactionClient) {
  const [market, targetUsers, targetTrades, targetPositions, targetNotifications, targetRequests, targetJournals, targetWallets, quotes, cleanupAudits] = await Promise.all([
    tx.market.findUnique({ where: { id: MARKET_ID }, include: {
      trades: { include: { user: { select: { username: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      positions: true,
      priceHistory: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
      collateralAccount: true,
    } }),
    tx.user.count({ where: { OR: [{ id: { in: [...TARGET_IDS] } }, { username: { in: [...TARGET_NAMES] } }] } }),
    tx.trade.count({ where: { userId: { in: [...TARGET_IDS] } } }),
    tx.position.count({ where: { userId: { in: [...TARGET_IDS] } } }),
    tx.notification.count({ where: { userId: { in: [...TARGET_IDS] } } }),
    tx.idempotencyRequest.count({ where: { userId: { in: [...TARGET_IDS] } } }),
    tx.journalEntry.count({ where: { OR: [
      { actorUserId: { in: [...TARGET_IDS] } },
      { referenceType: "USER", referenceId: { in: [...TARGET_IDS] } },
    ] } }),
    tx.ledgerAccount.count({ where: { ownerType: "USER", ownerId: { in: [...TARGET_IDS] } } }),
    tx.tradeQuote.count({ where: { marketId: MARKET_ID } }),
    tx.auditLog.findMany({ where: { action: "BOT_INCIDENT_REMOVED", entityType: "MARKET", entityId: MARKET_ID } }),
  ]);
  if (!market || market.slug !== MARKET_SLUG || market.pricingModel !== "LMSR" || market.executionBackend !== "DATABASE") fail("market identity changed");
  const targetResidue = { targetUsers, targetTrades, targetPositions, targetNotifications, targetRequests, targetJournals, targetWallets };
  if (Object.values(targetResidue).some(Boolean)) fail(`target account residue remains: ${json(targetResidue)}`);
  if (quotes !== 0) fail(`${quotes} stale market quotes remain`);
  if (cleanupAudits.length !== 1) fail(`expected one private cleanup audit, found ${cleanupAudits.length}`);

  if (market.trades.length !== EXPECTED_TRADES.size) fail(`expected ${EXPECTED_TRADES.size} retained trades, found ${market.trades.length}`);
  for (const trade of market.trades) {
    const expected = EXPECTED_TRADES.get(trade.id);
    if (!expected || trade.user.username !== expected.username || trade.side !== expected.side || trade.action !== expected.action ||
        trade.quantity !== expected.quantity || trade.amountMilli !== expected.amountMilli || trade.priceAfterBps !== expected.priceAfterBps) {
      fail(`retained trade changed: ${json({ id: trade.id, username: trade.user.username, side: trade.side, action: trade.action, quantity: trade.quantity, amountMilli: trade.amountMilli, priceAfterBps: trade.priceAfterBps })}`);
    }
  }
  const volumeMilli = market.trades.reduce((sum, trade) => sum + trade.amountMilli, 0n);
  const yesShares = market.trades.reduce((sum, trade) => sum + (trade.side === "YES" ? (trade.action === "BUY" ? trade.quantity : -trade.quantity) : 0), 0);
  const noShares = market.trades.reduce((sum, trade) => sum + (trade.side === "NO" ? (trade.action === "BUY" ? trade.quantity : -trade.quantity) : 0), 0);
  const traderCount = new Set(market.trades.map(trade => trade.userId)).size;
  if (market.volumeMilli !== EXPECTED_VOLUME_MILLI || volumeMilli !== EXPECTED_VOLUME_MILLI || market.yesShares !== EXPECTED_MARKET.yesShares ||
      yesShares !== EXPECTED_MARKET.yesShares || market.noShares !== EXPECTED_MARKET.noShares || noShares !== EXPECTED_MARKET.noShares ||
      market.traderCount !== EXPECTED_MARKET.traderCount || traderCount !== EXPECTED_MARKET.traderCount) {
    fail(`market aggregates differ from retained trades: ${json({ stored: { volumeMilli: market.volumeMilli, yesShares: market.yesShares, noShares: market.noShares, traderCount: market.traderCount }, replayed: { volumeMilli, yesShares, noShares, traderCount } })}`);
  }
  const positionYes = market.positions.reduce((sum, position) => sum + position.yesShares, 0);
  const positionNo = market.positions.reduce((sum, position) => sum + position.noShares, 0);
  if (positionYes !== market.yesShares || positionNo !== market.noShares || market.positions.some(position => position.reservedYesShares || position.reservedNoShares)) fail("position aggregates differ from market shares");

  if (market.priceHistory.length !== market.trades.length + 1 || market.priceHistory[0]?.yesProbabilityBps !== 5_000) fail("price history is not one opening point plus one point per retained trade");
  for (const trade of market.trades) {
    const snapshots = market.priceHistory.filter(snapshot => snapshot.createdAt.getTime() === trade.createdAt.getTime() && snapshot.yesProbabilityBps === trade.priceAfterBps);
    if (snapshots.length !== 1) fail(`trade ${trade.id} lacks one exact price snapshot`);
  }
  if (market.priceHistory.at(-1)?.yesProbabilityBps !== EXPECTED_MARKET.probabilityYesBps) fail("current probability snapshot changed");

  const tradeIds = [...EXPECTED_TRADES.keys()];
  const journals = await tx.journalEntry.findMany({ where: { referenceType: "TRADE", referenceId: { in: tradeIds } }, include: { postings: true } });
  if (journals.length !== tradeIds.length || new Set(journals.map(journal => journal.referenceId)).size !== tradeIds.length) fail("retained trades do not have exactly one journal each");
  for (const journal of journals) if (journal.status !== "POSTED" || journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n) fail(`retained trade journal ${journal.id} is not posted and balanced`);

  return {
    market: MARKET_SLUG,
    volumeMilli,
    trades: market.trades.length,
    snapshots: market.priceHistory.length,
    positions: market.positions.length,
    traderCount,
    yesShares,
    noShares,
    staleQuotes: quotes,
    targetResidue,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (process.env.VERCEL_ENV !== "production" || process.env.APP_URL !== "https://getgoosey.vercel.app" || process.env.DATABASE_PROVIDER !== "postgresql" || process.env.NEON_PROJECT_ID !== "round-mud-98593510") fail("destination identity mismatch");
  if (apply && process.env.GOOSEY_BOT_POSTCHECK_CONFIRM !== APPLY_CONFIRMATION) fail("apply confirmation mismatch");
  await requireDatabaseStartup();
  const result = await db.$transaction(async tx => {
    await tx.$queryRawUnsafe(`SELECT id FROM "Market" WHERE id = '${MARKET_ID}' FOR UPDATE`);
    const removedQuotes = apply ? (await tx.tradeQuote.deleteMany({ where: { marketId: MARKET_ID } })).count : 0;
    const verified = await verify(tx);
    return { mode: apply ? "apply" : "preview", removedQuotes, ...verified };
  }, { isolationLevel: "Serializable", timeout: 60_000 });
  console.log(json(result));
}

main().finally(() => db.$disconnect());
