import { spawnSync } from "node:child_process";
import { assertDatabaseFinancialMarket } from "../src/lib/market-backend";
import { chmod, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";

// Deliberately fixed: never treat every market in a database as disposable seed data.
const LEGACY_SLUGS = [
  "closing-ceremony-on-time", "hardware-top-prize", "gallery-150-projects",
  "midnight-snack-before-1215", "goose-in-demo", "ai-majority-finalists",
  "waterloo-team-podium", "outdoor-temperature-20", "workshop-capacity",
  "finalist-live-demo-success", "venue-wifi-through-demos",
];
const LEGACY_EVENT_SLUGS = ["hack-the-north-finals", "campus-hackathon-life"];
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function inspect(tx: Prisma.TransactionClient) {
  const markets = await tx.market.findMany({
    where: { slug: { in: LEGACY_SLUGS } },
    include: {
      createdBy: true,
      collateralAccount: { include: { postings: { include: { journalEntry: true } } } },
      positions: { include: { user: true } },
      _count: { select: {
        trades: true, orders: true, orderFills: true, orderCommands: true,
        orderEvents: true, orderReservations: true, settlements: true,
        resolutionProposals: true, comments: true,
      } },
      settlementRun: true,
    },
  });
  for (const market of markets) {
    assertDatabaseFinancialMarket(market);
    const fail = (reason: string): never => { throw new Error(`Refusing to remove ${market.slug}: ${reason}`); };
    if (market.createdBy.role !== "SYSTEM" || market.createdBy.email !== "system@goosey.local") fail("not created by the seed system account");
    const activity = Object.entries(market._count).filter(([, count]) => count > 0);
    if (activity.length) fail(`existing activity (${activity.map(([kind, count]) => `${kind}: ${count}`).join(", ")})`);
    if (market.settlementRun || market.resolvedAt || market.resolution || ["RESOLVED", "VOID"].includes(market.status)) fail("resolution or settlement activity");
    if (market.volumeMilli !== 0n || market.traderCount !== 0 || market.bookSequence !== 0n || market.commandSequence !== 0n || market.tradeSequence !== 0n) fail("nonzero trading counters");
    for (const position of market.positions) {
      if (position.userId !== market.createdById || position.user.role !== "SYSTEM") fail("a participant position exists");
      if (position.netCostMilli !== 0n || position.yesCostBasisMilli !== 0n || position.noCostBasisMilli !== 0n || position.realizedPnlMilli !== 0n || position.reservedYesShares || position.reservedNoShares) fail("system position has cost, profit, or reservations");
    }
    if (market.positions.reduce((sum, position) => sum + position.yesShares, 0) !== market.yesShares || market.positions.reduce((sum, position) => sum + position.noShares, 0) !== market.noShares) fail("share totals do not reconcile");
    const account = market.collateralAccount;
    if (account.ownerType !== "MARKET" || account.ownerId !== market.id || account.purpose !== "COLLATERAL" || account.balanceMilli < 0n) fail("unexpected collateral account");
    const posted = account.postings.filter((posting) => posting.journalEntry.status === "POSTED").reduce((sum, posting) => sum + posting.amountMilli, 0n);
    if (posted !== account.balanceMilli) fail("collateral does not reconcile with posted journal history");
    if (account.postings.some(({ journalEntry }) => journalEntry.type !== "MARKET_SUBSIDY" || journalEntry.idempotencyScope !== "seed-market" || journalEntry.referenceId !== market.id)) fail("collateral has activity beyond initial seed funding");
    const unexpectedJournals = await tx.journalEntry.count({ where: { referenceType: "MARKET", referenceId: market.id, NOT: { type: "MARKET_SUBSIDY", idempotencyScope: "seed-market" } } });
    if (unexpectedJournals) fail("market has journal activity beyond initial seed funding");
  }
  return markets.map((market) => { assertDatabaseFinancialMarket(market); return market; });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== "--apply") || args.length > 1) throw new Error("Usage: DATABASE_URL=file:./dev.db npx tsx scripts/replace-markets.ts [--apply]");
  const apply = args.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (process.env.DATABASE_PROVIDER && process.env.DATABASE_PROVIDER !== "sqlite") throw new Error("This replacement command supports local SQLite only.");
  if (!url?.startsWith("file:") || url.includes("?") || url.includes("#") || url.startsWith("file://") || url.includes(":memory:")) throw new Error("Set DATABASE_URL explicitly to a local SQLite file (file:./dev.db or file:/absolute/path.db), without URL parameters.");
  const suppliedPath = url.slice(5);
  const databasePath = await realpath(isAbsolute(suppliedPath) ? suppliedPath : resolve(projectRoot, "prisma", suppliedPath));
  if (!(await stat(databasePath)).isFile()) throw new Error("The SQLite database must already exist as a regular file.");
  const prisma = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  try {
    const preview = await prisma.$transaction((tx) => inspect(tx));
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", database: databasePath, legacyMarkets: preview.map(({ id, slug, collateralAccount }) => ({ id, slug, refundMilli: collateralAccount.balanceMilli.toString() })), next: "Run prisma/seed.ts to insert the Hack the North catalog." }, null, 2));
    if (!apply) return;

    // VACUUM INTO makes a consistent SQLite snapshot, including committed WAL data.
    const backupDirectory = resolve(projectRoot, "output", "database-backups");
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const backupPath = resolve(backupDirectory, `before-market-replacement-${Date.now()}.db`);
    await prisma.$executeRawUnsafe(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    await chmod(backupPath, 0o600);
    console.log(`Database backup: ${backupPath}`);

    await prisma.$transaction(async (tx) => {
      // Recheck inside the write transaction; a preflight check alone is insufficient.
      const markets = await inspect(tx);
      if (!markets.length) return;
      const treasury = await tx.ledgerAccount.findUniqueOrThrow({ where: { ownerType_ownerId_purpose: { ownerType: "SYSTEM", ownerId: "treasury", purpose: "TREASURY" } }, include: { postings: { include: { journalEntry: true } } } });
      const postedTreasury = treasury.postings.filter(({ journalEntry }) => journalEntry.status === "POSTED").reduce((sum, posting) => sum + posting.amountMilli, 0n);
      if (postedTreasury !== treasury.balanceMilli) throw new Error("Treasury does not reconcile; replacement canceled.");
      for (const market of markets) {
        const refund = market.collateralAccount.balanceMilli;
        if (refund > 0n) {
          await tx.journalEntry.create({ data: {
            type: "MARKET_SEED_RETIRED", referenceType: "MARKET", referenceId: market.id,
            idempotencyScope: "replace-legacy-seed", idempotencyKey: market.id,
            actorUserId: market.createdById,
            metadata: JSON.stringify({ slug: market.slug, reason: "Replace untouched legacy seed with Hack the North 2026 catalog" }),
            postings: { create: [
              { ledgerAccountId: market.collateralAccountId, amountMilli: -refund },
              { ledgerAccountId: treasury.id, amountMilli: refund },
            ] },
          } });
          await tx.ledgerAccount.update({ where: { id: treasury.id }, data: { balanceMilli: { increment: refund } } });
        }
        // Retain the zeroed collateral account and all historical journal postings.
        await tx.ledgerAccount.update({ where: { id: market.collateralAccountId }, data: { balanceMilli: 0n, status: "CLOSED" } });
        // Schema cascades remove only untouched system positions, price snapshots,
        // watchlists and quotes; suggestions survive with their market link cleared.
        await tx.market.delete({ where: { id: market.id } });
      }
      await tx.marketEvent.deleteMany({ where: { slug: { in: LEGACY_EVENT_SLUGS }, markets: { none: {} }, creationRequest: { is: null }, createdBy: { role: "SYSTEM" } } });
    }, { timeout: 30_000 });

    await prisma.$disconnect();
    const seedEnvironment: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: `file:${databasePath}` };
    delete seedEnvironment.ADMIN_EMAIL;
    delete seedEnvironment.ADMIN_PASSWORD;
    const seed = spawnSync(process.execPath, ["--import", "tsx", "prisma/seed.ts"], { cwd: projectRoot, env: seedEnvironment, stdio: "inherit" });
    if (seed.error || seed.status !== 0) throw new Error(`Legacy cleanup committed, but catalog seed failed. Correct the seed and rerun this command, or restore ${backupPath} with the app stopped. ${seed.error?.message ?? ""}`);
    console.log("Legacy markets replaced. User accounts, balances, and ledger history were preserved.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
