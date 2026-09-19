/** Real service integration; always provisions and removes its own temporary SQLite database. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "goosey-dance-e2e-"));
process.env.DATABASE_PROVIDER = "sqlite";
process.env.DATABASE_URL = `file:${join(directory, "test.sqlite")}`;
delete process.env.POSTGRES_DATABASE_URL;
delete process.env.POSTGRES_DIRECT_DATABASE_URL;
process.env.RATE_LIMIT_KEY_SECRET = randomBytes(32).toString("hex");
process.env.STARTING_FEATHERS = "10000";
let disconnect: (() => Promise<void>) | undefined;
try {
  await writeFile(join(directory, "test.sqlite"), "");
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"], { env: process.env, stdio: "pipe" });
  const { prisma: db } = await import("../src/lib/market-service");
  disconnect = () => db.$disconnect();
  const { hash } = await import("bcryptjs");
  const { createAdminMarket, createResolutionProposal, approveResolutionProposal } = await import("../src/lib/admin-service");
  const { createAdminEvent } = await import("../src/lib/event-service");
  const { grantWelcomeFeathers, registerUser } = await import("../src/lib/auth");
  const { createTradeQuote, executeTrade } = await import("../src/lib/trading");
  const { processSettlementRun } = await import("../src/lib/settlement-service");
  const { DANCE_MARKET_GROUP, danceMarketDefinitions } = await import("../src/lib/dance-market");
  const passwordHash = await hash(randomBytes(24).toString("hex"), 4);
  const admins = [];
  for (const username of ["creator", "proposer", "reviewer"]) {
    admins.push(await db.user.create({ data: { username, email: `${username}@example.test`, displayName: username, passwordHash, role: "ADMIN", emailVerifiedAt: new Date() } }));
  }
  const participant = await registerUser({ email: "dancer@example.test", username: "dancer", displayName: "Dance integration participant", password: randomBytes(24).toString("hex") });
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: participant.user.id }, data: { emailVerifiedAt: new Date() } });
    await grantWelcomeFeathers(tx, participant.user.id);
  });
  const closesAt = new Date(Date.now() + 3_600_000);
  const event = await createAdminEvent({ actorUserId: admins[0].id, idempotencyKey: "event", event: {
    slug: DANCE_MARKET_GROUP.slug, title: DANCE_MARKET_GROUP.title, shortTitle: DANCE_MARKET_GROUP.shortTitle,
    description: DANCE_MARKET_GROUP.description, category: DANCE_MARKET_GROUP.category, featured: true, color: "green", icon: "sparkles", startsAt: new Date(), endsAt: closesAt,
  } });
  const markets: Array<Awaited<ReturnType<typeof createAdminMarket>>["market"]> = [];
  for (const definition of danceMarketDefinitions) {
    markets.push((await createAdminMarket({ actorUserId: admins[0].id, idempotencyKey: definition.slug, market: {
      slug: definition.slug, title: definition.title, shortTitle: definition.shortTitle, description: definition.description,
      rules: definition.rules, resolutionSource: definition.resolutionSource, category: definition.category,
      featured: true, color: "green", icon: "sparkles", eventId: event.event.id, status: "OPEN", closesAt, resolvesAt: closesAt,
      liquidityParameter: 40, payoutMilli: 100_000n, feeBps: 0,
    } })).market);
  }
  for (const market of markets.slice(0, 2)) {
    for (const [action, quantity] of [["BUY", 4], ["SELL", 1]] as const) {
      const quote = await createTradeQuote({ userId: participant.user.id, marketId: market.id, side: "YES", action, quantity });
      await executeTrade({ userId: participant.user.id, marketId: market.id, quoteId: quote.quoteId, marketVersion: quote.marketVersion,
        ...(action === "BUY" ? { maxDebitMilli: quote.totalDebitMilli! } : { minCreditMilli: quote.netCreditMilli! }), idempotencyKey: `${market.id}-${action}` });
    }
  }
  const holdings = await db.position.findMany({ where: { userId: participant.user.id }, orderBy: { marketId: "asc" } });
  assert.equal(holdings.length, 2);
  assert(holdings.every((holding) => holding.yesShares === 3 && holding.noShares === 0));
  // Accelerate only contractual test timestamps after actual trading, never balances or fills.
  await db.market.updateMany({ data: { status: "CLOSED", acceptingOrders: false, closesAt: new Date(0), resolvesAt: new Date(0) } });
  const before = (await db.user.findUniqueOrThrow({ where: { id: participant.user.id } })).balanceMilli;
  for (const [index, market] of markets.entries()) {
    const proposal = await createResolutionProposal({ actorUserId: admins[1].id, marketId: market.id, idempotencyKey: `resolve-${market.id}`, resolution: {
      outcome: index === 0 ? "YES" : "NO", reason: "Isolated integration: Worm is first qualifying dance.", evidence: "Deterministic isolated integration scenario",
    } });
    const approval = await approveResolutionProposal({ actorUserId: admins[2].id, proposalId: proposal.proposal.id, idempotencyKey: `approve-${market.id}` });
    await processSettlementRun({ actorUserId: admins[2].id, runId: approval.run.id, batchSize: 100 });
    if (index === 0) {
      await assert.rejects(createResolutionProposal({ actorUserId: admins[1].id, marketId: markets[1].id, idempotencyKey: "reject-second-winner", resolution: {
        outcome: "YES", reason: "Attempt contradictory second winning dance.", evidence: "Isolated guard regression check",
      } }), (error: unknown) => (error as { code?: string }).code === "DANCE_OUTCOME_CONFLICT");
    }
  }
  const payouts = await db.positionSettlement.findMany({ where: { userId: participant.user.id } });
  assert.equal(payouts.find((payout) => payout.marketId === markets[0].id)?.payoutMilli, 300_000n);
  assert.equal(payouts.find((payout) => payout.marketId === markets[1].id)?.payoutMilli, 0n);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: participant.user.id } })).balanceMilli - before, 300_000n);
  for (const journal of await db.journalEntry.findMany({ include: { postings: true } })) {
    assert(journal.postings.length >= 2);
    assert.equal(journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n), 0n);
  }
  for (const account of await db.ledgerAccount.findMany({ include: { postings: true } })) {
    assert.equal(account.balanceMilli, account.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n));
  }
  assert.equal(await db.market.count({ where: { status: "RESOLVED", resolution: "YES" } }), 1);
  assert.equal(await db.market.count({ where: { status: "RESOLVED", resolution: "NO" } }), 3);
  console.log("PASS: isolated event creation, four markets, real grants, buy/sell separate options, conflicting winner rejection, one winning payout, and ledger reconciliation.");
} finally {
  await disconnect?.();
  await rm(directory, { recursive: true, force: true });
}
