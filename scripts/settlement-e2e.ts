import { requireDatabaseFinancialMarket } from "../src/lib/market-backend";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import {
  approveResolutionProposal,
  createAdminMarket,
  createResolutionProposal,
  rejectResolutionProposal,
} from "../src/lib/admin-service";
import { grantWelcomeFeathers, registerUser } from "../src/lib/auth";
import { initialSubsidyMilli } from "../src/lib/market-maker";
import { ApiError } from "../src/lib/market-service";
import { createTradeQuote, executeTrade } from "../src/lib/trading";
import {
  claimSettlementRun,
  processClaimedBatch,
  processSettlementRun,
} from "../src/lib/settlement-service";

const db = new PrismaClient();
const suffix = randomUUID().slice(0, 8);
const payoutMilli = 100_000n;

type UserRecord = Awaited<ReturnType<typeof db.user.create>>;
type Participant = Awaited<ReturnType<typeof createParticipant>>;

function fail(message: string): never {
  throw new Error(message);
}

function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) fail(`${message}: expected ${String(expected)}, received ${String(actual)}`);
}

async function expectApiError(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ApiError && error.code === code) return;
    throw error;
  }
  fail(`Expected API error ${code}`);
}

async function createAdmin(label: string): Promise<UserRecord> {
  const passwordHash = await hash(`Settlement-${label}-${suffix}-password`, 4);
  return db.user.create({
    data: {
      email: `${label}-${suffix}@goosey.test`,
      username: `${label}_${suffix}`,
      displayName: `${label} fixture`,
      passwordHash,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
    },
  });
}

async function createParticipant(label: string) {
  const result = await registerUser({
    email: `${label}-${suffix}@goosey.test`,
    username: `${label}_${suffix}`,
    displayName: `${label} fixture`,
    password: `Participant-${label}-${suffix}-password`,
  });
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: result.user.id }, data: { emailVerifiedAt: new Date() } });
    await grantWelcomeFeathers(tx, result.user.id);
  });
  return result;
}

async function createMarket(creator: UserRecord, label: string) {
  const closesAt = new Date(Date.now() + 3_600_000);
  return createAdminMarket({
    actorUserId: creator.id,
    idempotencyKey: `market-${label}-${suffix}`,
    market: {
      slug: `${label}-${suffix}`,
      title: `Will the ${label} integration fixture resolve correctly?`,
      shortTitle: `${label} integration fixture`,
      description: `An isolated integration fixture for the ${label} accounting and authorization path.`,
      rules: "The integration runner closes this market only after all intended trades are journaled.",
      resolutionSource: "Isolated Goosey integration runner",
      category: "Testing",
      status: "OPEN",
      featured: false,
      color: "gold",
      icon: "check",
      closesAt,
      resolvesAt: new Date(closesAt.getTime() + 60_000),
      liquidityParameter: 40,
      payoutMilli,
      feeBps: 125,
    },
  });
}

async function closeMarket(marketId: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await db.market.update({
    where: { id: marketId },
    data: { status: "CLOSED", closesAt: past, resolvesAt: past },
  });
}

async function trade(input: {
  userId: string;
  marketId: string;
  side: "YES" | "NO";
  action: "BUY" | "SELL";
  quantity: number;
  key: string;
}) {
  const quote = await createTradeQuote(input);
  const execution = await executeTrade({
    userId: input.userId,
    marketId: input.marketId,
    quoteId: quote.quoteId,
    marketVersion: quote.marketVersion,
    ...(input.action === "BUY"
      ? { maxDebitMilli: quote.totalDebitMilli! }
      : { minCreditMilli: quote.netCreditMilli! }),
    idempotencyKey: input.key,
  });
  return { quote, execution: execution as { trade: { id: string } } };
}

async function assertBalancedJournals(): Promise<void> {
  const journals = await db.journalEntry.findMany({ include: { postings: true } });
  const unbalanced = journals.filter(
    (journal) =>
      journal.postings.length < 2 ||
      journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) !== 0n,
  );
  expectEqual(unbalanced.length, 0, "every persisted financial journal must balance");
}

async function testMixedSideCostBasis(
  creator: UserRecord,
  participant: Participant,
  outsider: Participant,
): Promise<void> {
  const created = await createMarket(creator, "mixed-side");
  const marketId = created.market.id;
  const startingBalance = (
    await db.user.findUniqueOrThrow({ where: { id: participant.user.id }, select: { balanceMilli: true } })
  ).balanceMilli;

  await expectApiError(
    () => createTradeQuote({ userId: creator.id, marketId, side: "YES", action: "BUY", quantity: 1 }),
    "PARTICIPANT_REQUIRED",
  );

  const firstBuy = await trade({
    userId: participant.user.id,
    marketId,
    side: "YES",
    action: "BUY",
    quantity: 7,
    key: `buy-yes-${suffix}`,
  });
  const firstReplay = (await executeTrade({
    userId: participant.user.id,
    marketId,
    quoteId: firstBuy.quote.quoteId,
    marketVersion: firstBuy.quote.marketVersion,
    maxDebitMilli: firstBuy.quote.totalDebitMilli!,
    idempotencyKey: `buy-yes-${suffix}`,
  })) as { trade: { id: string } };
  expectEqual(firstReplay.trade.id, firstBuy.execution.trade.id, "trade replay must return the original trade");
  await expectApiError(
    () =>
      executeTrade({
        userId: participant.user.id,
        marketId,
        quoteId: firstBuy.quote.quoteId,
        marketVersion: firstBuy.quote.marketVersion,
        maxDebitMilli: firstBuy.quote.totalDebitMilli! + 1n,
        idempotencyKey: `buy-yes-${suffix}`,
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  await expectApiError(
    () =>
      executeTrade({
        userId: outsider.user.id,
        marketId,
        quoteId: firstBuy.quote.quoteId,
        marketVersion: firstBuy.quote.marketVersion,
        maxDebitMilli: firstBuy.quote.totalDebitMilli!,
        idempotencyKey: `quote-owner-${suffix}`,
      }),
    "QUOTE_NOT_FOUND",
  );

  let position = await db.position.findUniqueOrThrow({
    where: { userId_marketId: { userId: participant.user.id, marketId } },
  });
  expectEqual(position.yesCostBasisMilli, firstBuy.quote.totalDebitMilli!, "YES basis must equal its buy debit");
  expectEqual(position.noCostBasisMilli, 0n, "NO basis must remain zero after a YES buy");

  const noBuy = await trade({
    userId: participant.user.id,
    marketId,
    side: "NO",
    action: "BUY",
    quantity: 5,
    key: `buy-no-${suffix}`,
  });
  position = await db.position.findUniqueOrThrow({
    where: { userId_marketId: { userId: participant.user.id, marketId } },
  });
  expectEqual(position.yesCostBasisMilli, firstBuy.quote.totalDebitMilli!, "NO buy must not alter YES basis");
  expectEqual(position.noCostBasisMilli, noBuy.quote.totalDebitMilli!, "NO basis must equal its buy debit");
  expectEqual(
    position.netCostMilli,
    position.yesCostBasisMilli + position.noCostBasisMilli,
    "net basis must equal both side bases",
  );

  const yesBasisBefore = position.yesCostBasisMilli;
  const noBasisBefore = position.noCostBasisMilli;
  const realizedBefore = position.realizedPnlMilli;
  const yesPartial = await trade({
    userId: participant.user.id,
    marketId,
    side: "YES",
    action: "SELL",
    quantity: 3,
    key: `sell-yes-partial-${suffix}`,
  });
  const removedYesBasis = (yesBasisBefore * 3n) / 7n;
  position = await db.position.findUniqueOrThrow({
    where: { userId_marketId: { userId: participant.user.id, marketId } },
  });
  expectEqual(
    position.yesCostBasisMilli,
    yesBasisBefore - removedYesBasis,
    "partial YES sell must remove proportional YES basis",
  );
  expectEqual(position.noCostBasisMilli, noBasisBefore, "YES sell must not alter NO basis");
  expectEqual(
    position.realizedPnlMilli,
    realizedBefore + yesPartial.quote.netCreditMilli! - removedYesBasis,
    "partial YES realized PnL must use removed YES basis",
  );

  const noBasisBeforeSell = position.noCostBasisMilli;
  const noPartial = await trade({
    userId: participant.user.id,
    marketId,
    side: "NO",
    action: "SELL",
    quantity: 2,
    key: `sell-no-partial-${suffix}`,
  });
  const removedNoBasis = (noBasisBeforeSell * 2n) / 5n;
  position = await db.position.findUniqueOrThrow({
    where: { userId_marketId: { userId: participant.user.id, marketId } },
  });
  expectEqual(
    position.noCostBasisMilli,
    noBasisBeforeSell - removedNoBasis,
    "partial NO sell must remove proportional NO basis",
  );
  expectEqual(
    position.yesCostBasisMilli,
    yesBasisBefore - removedYesBasis,
    "NO sell must not alter YES basis",
  );
  expectEqual(
    position.netCostMilli,
    position.yesCostBasisMilli + position.noCostBasisMilli,
    "remaining net basis must equal both side bases",
  );

  const yesFinal = await trade({
    userId: participant.user.id,
    marketId,
    side: "YES",
    action: "SELL",
    quantity: 4,
    key: `sell-yes-final-${suffix}`,
  });
  const noFinal = await trade({
    userId: participant.user.id,
    marketId,
    side: "NO",
    action: "SELL",
    quantity: 3,
    key: `sell-no-final-${suffix}`,
  });
  position = await db.position.findUniqueOrThrow({
    where: { userId_marketId: { userId: participant.user.id, marketId } },
  });
  const [market, user, wallet, revenue] = await Promise.all([
    db.market.findUniqueOrThrow({ where: { id: marketId }, include: { collateralAccount: true } }),
    db.user.findUniqueOrThrow({ where: { id: participant.user.id } }),
    db.ledgerAccount.findUniqueOrThrow({
      where: {
        ownerType_ownerId_purpose: {
          ownerType: "USER",
          ownerId: participant.user.id,
          purpose: "USER_FEATHERS",
        },
      },
    }),
    db.ledgerAccount.findUniqueOrThrow({
      where: {
        ownerType_ownerId_purpose: {
          ownerType: "SYSTEM",
          ownerId: "GOOSEY",
          purpose: "PROTOCOL_REVENUE",
        },
      },
    }),
  ]);
  expectEqual(position.yesShares, 0, "full liquidation must clear YES shares");
  expectEqual(position.noShares, 0, "full liquidation must clear NO shares");
  expectEqual(position.yesCostBasisMilli, 0n, "full liquidation must clear YES basis");
  expectEqual(position.noCostBasisMilli, 0n, "full liquidation must clear NO basis");
  expectEqual(position.netCostMilli, 0n, "full liquidation must clear net basis");
  expectEqual(market.yesShares, 0, "market YES inventory must return to origin");
  expectEqual(market.noShares, 0, "market NO inventory must return to origin");
  expectEqual(user.balanceMilli, wallet.balanceMilli, "user projection and ledger wallet must reconcile");
  expectEqual(
    user.balanceMilli - startingBalance,
    position.realizedPnlMilli,
    "fully liquidated wallet delta must equal realized PnL",
  );
  const totalFees = [
    firstBuy.quote,
    noBuy.quote,
    yesPartial.quote,
    noPartial.quote,
    yesFinal.quote,
    noFinal.quote,
  ].reduce((sum, quote) => sum + quote.feeMilli, 0n);
  const grossBought = firstBuy.quote.grossMilli + noBuy.quote.grossMilli;
  const grossSold =
    yesPartial.quote.grossMilli +
    noPartial.quote.grossMilli +
    yesFinal.quote.grossMilli +
    noFinal.quote.grossMilli;
  const conservativeRoundingSurplus = grossBought - grossSold;
  if (conservativeRoundingSurplus < 0n || conservativeRoundingSurplus > 12n) {
    fail(`roundtrip rounding surplus is outside its conservative bound: ${conservativeRoundingSurplus}`);
  }
  expectEqual(
    requireDatabaseFinancialMarket(market).collateralAccount.balanceMilli,
    initialSubsidyMilli(market.liquidityParameter, market.payoutMilli) + conservativeRoundingSurplus,
    "roundtrip collateral must equal subsidy plus conservative rounding surplus",
  );
  expectEqual(revenue.balanceMilli, totalFees, "protocol revenue must equal all charged roundtrip fees");
}

async function testResolutionApproval(
  creator: UserRecord,
  proposer: UserRecord,
  resolver: UserRecord,
  participant: Participant,
  losingParticipant: Participant,
): Promise<void> {
  const created = await createMarket(creator, "single-admin-resolution");
  const marketId = created.market.id;
  // A participant can become an admin after trading; settlement must still work.
  await db.user.update({ where: { id: participant.user.id }, data: { role: "USER" } });
  await trade({
    userId: participant.user.id,
    marketId,
    side: "YES",
    action: "BUY",
    quantity: 3,
    key: `settlement-winner-yes-${suffix}`,
  });
  await trade({
    userId: participant.user.id,
    marketId,
    side: "NO",
    action: "BUY",
    quantity: 2,
    key: `settlement-winner-no-${suffix}`,
  });
  await trade({
    userId: losingParticipant.user.id,
    marketId,
    side: "NO",
    action: "BUY",
    quantity: 4,
    key: `settlement-loser-no-${suffix}`,
  });
  await db.user.update({ where: { id: participant.user.id }, data: { role: "ADMIN" } });
  await closeMarket(marketId);
  await db.market.update({ where: { id: marketId }, data: { status: "OPEN" } });
  const [winnerBeforeSettlement, loserBeforeSettlement] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: participant.user.id } }),
    db.user.findUniqueOrThrow({ where: { id: losingParticipant.user.id } }),
  ]);

  const resolution = {
    outcome: "YES" as const,
    reason: "The isolated fixture explicitly records the YES condition as satisfied.",
    evidence: "Integration runner assertion",
  };
  await expectApiError(
    () =>
      createResolutionProposal({
        actorUserId: losingParticipant.user.id,
        marketId,
        idempotencyKey: `user-proposal-${suffix}`,
        resolution,
      }),
    "ADMIN_REQUIRED",
  );
  const proposal = await createResolutionProposal({
    actorUserId: proposer.id,
    marketId,
    idempotencyKey: `proposal-${suffix}`,
    resolution,
  });
  const replayedProposal = await createResolutionProposal({
    actorUserId: proposer.id,
    marketId,
    idempotencyKey: `proposal-${suffix}`,
    resolution,
  });
  expectEqual(replayedProposal.replayed, true, "identical proposal retry must replay");
  expectEqual(replayedProposal.proposal.id, proposal.proposal.id, "proposal replay must return original proposal");
  await expectApiError(
    () =>
      createResolutionProposal({
        actorUserId: proposer.id,
        marketId,
        idempotencyKey: `proposal-${suffix}`,
        resolution: { ...resolution, outcome: "NO" },
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  await expectApiError(
    () =>
      createResolutionProposal({
        actorUserId: resolver.id,
        marketId,
        idempotencyKey: `second-pending-${suffix}`,
        resolution,
      }),
    "PROPOSAL_PENDING",
  );
  const approval = await approveResolutionProposal({
    actorUserId: resolver.id,
    proposalId: proposal.proposal.id,
    idempotencyKey: `approve-${suffix}`,
  });
  const approvalReplay = await approveResolutionProposal({
    actorUserId: resolver.id,
    proposalId: proposal.proposal.id,
    idempotencyKey: `approve-${suffix}`,
  });
  expectEqual(approval.replayed, false, "first approval must create an immutable settlement run");
  expectEqual(approvalReplay.replayed, true, "same-key approval retry must replay the same settlement run");
  expectEqual(approvalReplay.run.id, approval.run.id, "approval replay must preserve the unique market run");
  await expectApiError(
    () =>
      approveResolutionProposal({
        actorUserId: resolver.id,
        proposalId: proposal.proposal.id,
        idempotencyKey: `approve-retry-${suffix}`,
      }),
    "PROPOSAL_ALREADY_REVIEWED",
  );
  const afterApproval = await db.market.findUniqueOrThrow({
    where: { id: marketId },
    include: { collateralAccount: true },
  });
  expectEqual(afterApproval.status, "RESOLVING", "approval must freeze the market before any payout");
  expectEqual(afterApproval.resolution, "YES", "approved outcome must be immutable before payouts begin");
  expectEqual(
    await db.positionSettlement.count({ where: { marketId } }),
    0,
    "approval must not settle a position inside the approval transaction",
  );

  const firstClaim = await claimSettlementRun({
    actorUserId: resolver.id,
    runId: approval.run.id,
    leaseMs: 120_000,
  });
  if (!firstClaim.claimToken) fail("new settlement run must produce a worker claim");
  await db.marketSettlementRun.update({
    where: { id: approval.run.id },
    data: { claimToken: `replacement-${suffix}`, leaseExpiresAt: new Date(Date.now() + 120_000) },
  });
  await expectApiError(
    () => processClaimedBatch({
      actorUserId: resolver.id,
      runId: approval.run.id,
      claimToken: firstClaim.claimToken!,
      batchSize: 1,
    }),
    "SETTLEMENT_CLAIM_LOST",
  );
  expectEqual(
    await db.positionSettlement.count({ where: { marketId } }),
    0,
    "a stale worker token must not settle or advance any position",
  );
  await db.marketSettlementRun.update({
    where: { id: approval.run.id },
    data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
  });
  const firstBatch = await processSettlementRun({
    actorUserId: resolver.id,
    runId: approval.run.id,
    batchSize: 1,
  });
  expectEqual(firstBatch.run.processedCount, 1, "resumed worker must process exactly one requested position");
  expectEqual(firstBatch.run.status, "READY", "a partial batch must remain resumable");
  const duringSettlement = await db.market.findUniqueOrThrow({
    where: { id: marketId },
    include: { collateralAccount: true },
  });
  expectEqual(duringSettlement.status, "RESOLVING", "market must remain nonterminal between batches");
  expectEqual(requireDatabaseFinancialMarket(duringSettlement).collateralAccount.status, "ACTIVE", "collateral must remain open between batches");

  const finalBatch = await processSettlementRun({
    actorUserId: resolver.id,
    runId: approval.run.id,
    batchSize: 1,
  });
  expectEqual(finalBatch.run.status, "COMPLETED", "the last batch must finalize the durable run");
  expectEqual(finalBatch.run.totalPayoutMilli, 300_000n, "YES settlement must pay only three winning contracts");
  const settlementReplay = await processSettlementRun({
    actorUserId: resolver.id,
    runId: approval.run.id,
    batchSize: 1,
  });
  expectEqual(settlementReplay.replayed, true, "completed settlement processing must replay safely");

  const [
    market,
    positions,
    settlements,
    winner,
    loser,
    winnerWallet,
    loserWallet,
    proposalAfter,
    notifications,
    resolutionAudits,
    terminalSnapshot,
  ] = await Promise.all([
    db.market.findUniqueOrThrow({ where: { id: marketId }, include: { collateralAccount: true } }),
    db.position.findMany({ where: { marketId }, orderBy: { userId: "asc" } }),
    db.positionSettlement.findMany({ where: { marketId }, orderBy: { userId: "asc" } }),
    db.user.findUniqueOrThrow({ where: { id: participant.user.id } }),
    db.user.findUniqueOrThrow({ where: { id: losingParticipant.user.id } }),
    db.ledgerAccount.findUniqueOrThrow({
      where: {
        ownerType_ownerId_purpose: {
          ownerType: "USER",
          ownerId: participant.user.id,
          purpose: "USER_FEATHERS",
        },
      },
    }),
    db.ledgerAccount.findUniqueOrThrow({
      where: {
        ownerType_ownerId_purpose: {
          ownerType: "USER",
          ownerId: losingParticipant.user.id,
          purpose: "USER_FEATHERS",
        },
      },
    }),
    db.marketResolutionProposal.findUniqueOrThrow({ where: { id: proposal.proposal.id } }),
    db.notification.findMany({
      where: {
        userId: { in: [participant.user.id, losingParticipant.user.id] },
        type: "MARKET_RESOLVED",
      },
    }),
    db.auditLog.findMany({
      where: { entityType: "MARKET", entityId: marketId, action: "MARKET_RESOLVED" },
    }),
    db.marketPriceSnapshot.findFirstOrThrow({ where: { marketId }, orderBy: { createdAt: "desc" } }),
  ]);
  expectEqual(market.status, "RESOLVED", "approved proposal must resolve market");
  expectEqual(market.resolution, "YES", "approved proposal outcome must be authoritative");
  expectEqual(market.yesShares, 0, "terminal market must clear YES shares");
  expectEqual(market.noShares, 0, "terminal market must clear NO shares");
  expectEqual(requireDatabaseFinancialMarket(market).collateralAccount.balanceMilli, 0n, "settlement must close out market collateral");
  expectEqual(requireDatabaseFinancialMarket(market).collateralAccount.status, "CLOSED", "settlement must close collateral account");
  expectEqual(terminalSnapshot.yesProbabilityBps, 10_000, "YES settlement must append terminal probability");
  expectEqual(positions.length, 2, "both participant positions must be retained as settled records");
  for (const position of positions) {
    expectEqual(position.yesShares, 0, "settled position must clear YES shares");
    expectEqual(position.noShares, 0, "settled position must clear NO shares");
    expectEqual(position.netCostMilli, 0n, "settled position must clear net basis");
    expectEqual(position.yesCostBasisMilli, 0n, "settled position must clear YES basis");
    expectEqual(position.noCostBasisMilli, 0n, "settled position must clear NO basis");
  }
  expectEqual(settlements.length, 2, "settlement must create one durable record per position");
  expectEqual(
    settlements.reduce((sum, item) => sum + item.payoutMilli, 0n),
    300_000n,
    "durable settlements must reconcile to total payout",
  );
  expectEqual(winner.balanceMilli, winnerBeforeSettlement.balanceMilli + 300_000n, "winner balance must receive exact payout");
  expectEqual(loser.balanceMilli, loserBeforeSettlement.balanceMilli, "loser balance must not receive a payout");
  expectEqual(winner.balanceMilli, winnerWallet.balanceMilli, "winner projection and wallet must reconcile");
  expectEqual(loser.balanceMilli, loserWallet.balanceMilli, "loser projection and wallet must reconcile");
  const winnerSettlement = settlements.find((item) => item.userId === winner.id) ?? fail("winner settlement missing");
  const loserSettlement = settlements.find((item) => item.userId === loser.id) ?? fail("loser settlement missing");
  expectEqual(winnerSettlement.payoutMilli, 300_000n, "winner payout must equal contracts times payout");
  expectEqual(loserSettlement.payoutMilli, 0n, "losing-only position must settle to zero");
  expectEqual(loserSettlement.journalEntryId, null, "zero payout must not create an empty financial journal");
  expectEqual(proposalAfter.status, "APPROVED", "settled proposal must be approved");
  expectEqual(proposalAfter.approverId, resolver.id, "approval must record the administrator");
  expectEqual(notifications.length, 2, "each settled participant must receive exactly one notification");
  expectEqual(resolutionAudits.length, 1, "settlement retries must not duplicate resolution audit events");
}

async function testRejectedProposal(
  creator: UserRecord,
  proposer: UserRecord,
  resolver: UserRecord,
): Promise<void> {
  const created = await createMarket(creator, "rejected-resolution");
  await closeMarket(created.market.id);
  await db.market.update({ where: { id: created.market.id }, data: { status: "PAUSED" } });
  const proposal = await createResolutionProposal({
    actorUserId: proposer.id,
    marketId: created.market.id,
    idempotencyKey: `rejected-proposal-${suffix}`,
    resolution: {
      outcome: "VOID",
      reason: "The fixture intentionally exercises the rejection path before any settlement.",
      evidence: "Integration runner rejection assertion",
    },
  });
  const rejected = await rejectResolutionProposal({
    actorUserId: proposer.id,
    proposalId: proposal.proposal.id,
    note: "Evidence is insufficient for settlement.",
  });
  expectEqual(rejected.proposal.status, "REJECTED", "distinct reviewer must be able to reject a proposal");
  await expectApiError(
    () =>
      approveResolutionProposal({
        actorUserId: resolver.id,
        proposalId: proposal.proposal.id,
        idempotencyKey: `approve-rejected-${suffix}`,
      }),
    "PROPOSAL_ALREADY_REVIEWED",
  );
  const market = await db.market.findUniqueOrThrow({ where: { id: created.market.id } });
  expectEqual(market.status, "CLOSED", "rejection must not settle the market");
  expectEqual(market.resolution, null, "rejection must not assign an outcome");
}

async function testMultiBatchSettlement(
  creator: UserRecord,
  proposer: UserRecord,
  resolver: UserRecord,
): Promise<void> {
  const created = await createMarket(creator, "multi-batch-resolution");
  const marketId = created.market.id;
  const passwordHash = await hash(`Multi-batch-${suffix}-password`, 4);
  const activeUsers = Array.from({ length: 205 }, (_, index) => ({
    id: randomUUID(),
    email: `multi-${index}-${suffix}@goosey.test`,
    username: `multi_${index}_${suffix}`,
    displayName: `Multi batch participant ${index}`,
    passwordHash,
  }));
  const redeemedUserId = randomUUID();
  await db.user.createMany({
    data: [
      ...activeUsers,
      {
        id: redeemedUserId,
        email: `redeemed-${suffix}@goosey.test`,
        username: `redeemed_${suffix}`,
        displayName: "Redeemed position fixture",
        passwordHash,
      },
    ],
  });
  await db.position.createMany({
    data: [
      ...activeUsers.map((user) => ({
        userId: user.id,
        marketId,
        yesShares: 1,
      })),
      {
        userId: redeemedUserId,
        marketId,
        yesShares: 0,
        noShares: 0,
      },
    ],
  });
  await closeMarket(marketId);
  const proposal = await createResolutionProposal({
    actorUserId: proposer.id,
    marketId,
    idempotencyKey: `multi-proposal-${suffix}`,
    resolution: {
      outcome: "NO",
      reason: "The integration fixture records NO so every active YES-only position has zero payout.",
      evidence: "Deterministic multi-batch integration fixture",
    },
  });
  const approval = await approveResolutionProposal({
    actorUserId: resolver.id,
    proposalId: proposal.proposal.id,
    idempotencyKey: `multi-approve-${suffix}`,
  });
  expectEqual(approval.run.totalPositions, 205, "run workload must include only nonzero-share positions");

  const batchOne = await processSettlementRun({ actorUserId: resolver.id, runId: approval.run.id, batchSize: 100 });
  expectEqual(batchOne.run.processedCount, 100, "first batch must stop at 100 positions");
  expectEqual(batchOne.run.status, "READY", "first multi-batch step must remain resumable");
  const batchTwo = await processSettlementRun({ actorUserId: resolver.id, runId: approval.run.id, batchSize: 100 });
  expectEqual(batchTwo.run.processedCount, 200, "second batch must advance deterministically to 200");
  const beforeFinal = await db.market.findUniqueOrThrow({
    where: { id: marketId },
    include: { collateralAccount: true },
  });
  expectEqual(beforeFinal.status, "RESOLVING", "multi-batch market must remain resolving before the last batch");
  expectEqual(requireDatabaseFinancialMarket(beforeFinal).collateralAccount.status, "ACTIVE", "collateral must remain open until all positions settle");

  const finalBatch = await processSettlementRun({ actorUserId: resolver.id, runId: approval.run.id, batchSize: 100 });
  expectEqual(finalBatch.run.processedCount, 205, "final batch must settle the exact snapshotted workload");
  expectEqual(finalBatch.run.batchCount, 3, "205 positions must require exactly three bounded batches");
  expectEqual(finalBatch.run.status, "COMPLETED", "multi-batch run must finalize after its last five positions");
  expectEqual(finalBatch.run.totalPayoutMilli, 0n, "losing-only multi-batch fixture must pay zero");

  const [settlements, activeNotifications, redeemedNotifications, terminalMarket] = await Promise.all([
    db.positionSettlement.findMany({ where: { settlementRunId: approval.run.id } }),
    db.notification.count({
      where: { userId: { in: activeUsers.map((user) => user.id) }, type: "MARKET_RESOLVED" },
    }),
    db.notification.count({ where: { userId: redeemedUserId, type: "MARKET_RESOLVED" } }),
    db.market.findUniqueOrThrow({ where: { id: marketId }, include: { collateralAccount: true } }),
  ]);
  expectEqual(settlements.length, 205, "each active position must have exactly one durable settlement");
  expectEqual(settlements.every((settlement) => settlement.journalEntryId === null), true, "zero payouts must not create empty journals");
  expectEqual(activeNotifications, 205, "each active exposure must receive one resolution notification");
  expectEqual(redeemedNotifications, 0, "zero-share historical rows must receive no resolution notification");
  expectEqual(terminalMarket.status, "RESOLVED", "market may become terminal only after all batches complete");
  expectEqual(requireDatabaseFinancialMarket(terminalMarket).collateralAccount.status, "CLOSED", "collateral may close only after all batches complete");

  const replay = await processSettlementRun({ actorUserId: resolver.id, runId: approval.run.id, batchSize: 100 });
  expectEqual(replay.replayed, true, "multi-batch completion must replay without duplicate settlements");
  expectEqual(
    await db.positionSettlement.count({ where: { settlementRunId: approval.run.id } }),
    205,
    "settlement replay must preserve exactly-once records",
  );
}

async function main() {
  const [creator, proposer, resolver] = await Promise.all([
    createAdmin("creator"),
    createAdmin("proposer"),
    createAdmin("resolver"),
  ]);
  const [participant, outsider, losingParticipant] = await Promise.all([
    createParticipant("participant"),
    createParticipant("outsider"),
    createParticipant("loser"),
  ]);

  await testMixedSideCostBasis(creator, participant, outsider);
  const participatingAdmin = await db.user.update({ where: { id: participant.user.id }, data: { role: "ADMIN" } });
  await testResolutionApproval(
    participatingAdmin,
    participatingAdmin,
    participatingAdmin,
    participant,
    losingParticipant,
  );
  await testRejectedProposal(creator, proposer, resolver);
  await testMultiBatchSettlement(creator, proposer, resolver);
  await assertBalancedJournals();

  console.log(
    JSON.stringify({
      ok: true,
      database: process.env.DATABASE_URL,
      assertions: [
        "mixed-side-cost-basis",
        "partial-and-full-sells",
        "trade-idempotency-and-authorization",
        "single-admin-creator-trader-resolution",
        "proposal-idempotency",
        "exact-settlement-and-terminal-replay",
        "proposal-rejection",
        "durable-multi-batch-resume-and-worker-fencing",
        "zero-share-position-exclusion",
        "balanced-journals",
      ],
    }),
  );
}

main().finally(() => db.$disconnect());
