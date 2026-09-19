import { randomUUID } from "node:crypto";

import {
  approveResolutionProposal,
  createAdminMarket,
  createMarketSchema,
  createResolutionProposal,
  transitionAdminMarket,
} from "../src/lib/admin-service";
import { grantWelcomeFeathers, welcomeGrantMilliFromEnvironment } from "../src/lib/auth";
import { db } from "../src/lib/db";
import { placeOrder } from "../src/lib/order-exchange";
import { runSerializableTransaction } from "../src/lib/serializable-transaction";
import { processSettlementRun } from "../src/lib/settlement-service";
import { loadPositionValuations } from "../src/lib/position-valuation";

const suffix = randomUUID().slice(0, 8);
const payoutMilli = 100_000n;
const participantFundingMilli = 1_000_000n;
const contractQuantity = 2;

type Outcome = "YES" | "NO" | "VOID";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createAdmin(label: string) {
  return db.user.create({
    data: {
      email: `orderbook-settlement-${label}-${suffix}@goosey.test`,
      username: `orderbook_settlement_${label}_${suffix}`,
      displayName: `Order-book settlement ${label}`,
      passwordHash: "isolated-order-book-settlement-fixture-only",
      role: "ADMIN",
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
}

async function createFundedParticipant(label: string) {
  return runSerializableTransaction(db, async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `orderbook-settlement-${label}-${suffix}@goosey.test`,
        username: `orderbook_settlement_${label}_${suffix}`,
        displayName: `Order-book settlement ${label}`,
        passwordHash: "isolated-order-book-settlement-fixture-only",
        role: "USER",
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });

    let configuredGrantMilli: bigint | null = null;
    try {
      configuredGrantMilli = welcomeGrantMilliFromEnvironment();
    } catch {
      // The deterministic fixture grant below remains fully ledger-backed when
      // the deployment's welcome-grant configuration is unavailable.
    }
    if (
      configuredGrantMilli === participantFundingMilli &&
      await grantWelcomeFeathers(tx, user.id)
    ) {
      return tx.user.findUniqueOrThrow({ where: { id: user.id } });
    }

    const source = await tx.ledgerAccount.create({
      data: {
        ownerType: "SYSTEM",
        ownerId: `orderbook-settlement:${suffix}:${label}`,
        purpose: "FIXTURE_ISSUANCE",
        allowsNegative: true,
      },
    });
    const wallet = await tx.ledgerAccount.create({
      data: {
        ownerType: "USER",
        ownerId: user.id,
        purpose: "USER_FEATHERS",
      },
    });
    await tx.journalEntry.create({
      data: {
        type: "FIXTURE_GRANT",
        referenceType: "USER",
        referenceId: user.id,
        idempotencyScope: "ORDERBOOK_SETTLEMENT_E2E_FIXTURE",
        idempotencyKey: `${suffix}:${label}`,
        actorUserId: user.id,
        metadata: JSON.stringify({ amountMilli: participantFundingMilli.toString() }),
        postings: {
          create: [
            { ledgerAccountId: source.id, amountMilli: -participantFundingMilli },
            { ledgerAccountId: wallet.id, amountMilli: participantFundingMilli },
          ],
        },
      },
    });
    await Promise.all([
      tx.ledgerAccount.update({
        where: { id: source.id },
        data: { balanceMilli: { decrement: participantFundingMilli } },
      }),
      tx.ledgerAccount.update({
        where: { id: wallet.id },
        data: { balanceMilli: { increment: participantFundingMilli } },
      }),
      tx.user.update({
        where: { id: user.id },
        data: { balanceMilli: { increment: participantFundingMilli } },
      }),
    ]);
    return tx.user.findUniqueOrThrow({ where: { id: user.id } });
  });
}

async function createScenario(
  outcome: Outcome,
  creatorId: string,
) {
  const label = outcome.toLowerCase();
  const contractualAt = new Date(Date.now() + 60 * 60 * 1_000);
  const definition = createMarketSchema.parse({
    slug: `orderbook-settlement-${label}-${suffix}`,
    title: `Will the ${label.toUpperCase()} order-book settlement conserve every feather?`,
    shortTitle: `${label.toUpperCase()} order-book settlement`,
    description: "A disposable CLOB market exercising the complete settlement lifecycle.",
    rules: "The deterministic integration fixture resolves to its named outcome.",
    resolutionSource: "Order-book settlement integration runner",
    category: "Testing",
    status: "OPEN",
    pricingModel: "ORDER_BOOK",
    closesAt: contractualAt.toISOString(),
    resolvesAt: contractualAt.toISOString(),
    payoutMilli: payoutMilli.toString(),
    feeBps: 0,
  });
  const created = await createAdminMarket({
    actorUserId: creatorId,
    idempotencyKey: `create-${label}-${suffix}`,
    market: definition,
  });
  assert(created.subsidyMilli === 0n, `${outcome} CLOB received a synthetic subsidy`);

  const yesParticipant = await createFundedParticipant(`${label}_yes`);
  const noParticipant = await createFundedParticipant(`${label}_no`);

  await placeOrder({
    userId: yesParticipant.id,
    idempotencyKey: `mint-yes-${label}-${suffix}`,
    request: {
      marketId: created.market.id,
      clientOrderId: `mint-yes-${label}-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "40000",
      quantity: contractQuantity,
      timeInForce: "GTC",
    },
  });
  await placeOrder({
    userId: noParticipant.id,
    idempotencyKey: `mint-no-${label}-${suffix}`,
    request: {
      marketId: created.market.id,
      clientOrderId: `mint-no-${label}-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: contractQuantity,
      timeInForce: "IOC",
    },
  });

  const [yesAfterMatch, noAfterMatch, marketAfterMatch, fillCount] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: yesParticipant.id } }),
    db.user.findUniqueOrThrow({ where: { id: noParticipant.id } }),
    db.market.findUniqueOrThrow({
      where: { id: created.market.id },
      include: { collateralAccount: true },
    }),
    db.orderFill.count({ where: { marketId: created.market.id } }),
  ]);
  assert(yesAfterMatch.balanceMilli === 920_000n, `${outcome} YES mint debit was not exact`);
  assert(noAfterMatch.balanceMilli === 880_000n, `${outcome} NO mint debit was not exact`);
  assert(fillCount === 1, `${outcome} complete-set mint did not create exactly one fill`);
  assert(
    marketAfterMatch.yesShares === contractQuantity &&
      marketAfterMatch.noShares === contractQuantity &&
      marketAfterMatch.collateralAccount.balanceMilli === 200_000n,
    `${outcome} mint did not create participant-backed complete sets`,
  );

  await placeOrder({
    userId: noParticipant.id,
    idempotencyKey: `resting-cash-${label}-${suffix}`,
    request: {
      marketId: created.market.id,
      clientOrderId: `resting-cash-${label}-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "30000",
      quantity: 1,
      timeInForce: "GTC",
    },
  });
  await placeOrder({
    userId: yesParticipant.id,
    idempotencyKey: `resting-shares-${label}-${suffix}`,
    request: {
      marketId: created.market.id,
      clientOrderId: `resting-shares-${label}-${suffix}`,
      outcome: "YES",
      action: "SELL",
      limitPriceMilli: "70000",
      quantity: 1,
      timeInForce: "GTC",
    },
  });

  const [cashReservedUser, reservedPosition, activeReservations] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: noParticipant.id } }),
    db.position.findUniqueOrThrow({
      where: {
        userId_marketId: { userId: yesParticipant.id, marketId: created.market.id },
      },
    }),
    db.orderReservation.findMany({
      where: {
        marketId: created.market.id,
        OR: [
          { reservedPrincipalMilli: { gt: 0n } },
          { reservedFeeMilli: { gt: 0n } },
          { reservedYesQuantity: { gt: 0 } },
          { reservedNoQuantity: { gt: 0 } },
        ],
      },
    }),
  ]);
  assert(cashReservedUser.balanceMilli === 850_000n, `${outcome} cash reservation was not exact`);
  assert(reservedPosition.reservedYesShares === 1, `${outcome} sell reservation did not reserve one YES share`);
  assert(
    activeReservations.some((reservation) => reservation.reservedPrincipalMilli === 30_000n) &&
      activeReservations.some((reservation) => reservation.reservedYesQuantity === 1),
    `${outcome} did not retain both cash and share reservations before close`,
  );

  const beforeClose = await db.market.findUniqueOrThrow({ where: { id: created.market.id } });
  const closed = await transitionAdminMarket({
    actorUserId: creatorId,
    marketId: created.market.id,
    action: "CLOSE",
    reason: "Settlement integration fixture completed trading.",
    expectedVersion: beforeClose.version,
  });
  assert(closed.market.status === "CLOSED", `${outcome} admin close did not close the market`);
  const resolutionEligibleAt = new Date(Date.now() - 1_000);
  await db.market.update({
    where: { id: created.market.id },
    data: { closesAt: resolutionEligibleAt, resolvesAt: resolutionEligibleAt },
  });

  const [yesAfterClose, noAfterClose, positionAfterClose, openOrders, liveReservations] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: yesParticipant.id } }),
    db.user.findUniqueOrThrow({ where: { id: noParticipant.id } }),
    db.position.findUniqueOrThrow({
      where: {
        userId_marketId: { userId: yesParticipant.id, marketId: created.market.id },
      },
    }),
    db.marketOrder.count({
      where: {
        marketId: created.market.id,
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
      },
    }),
    db.orderReservation.count({
      where: {
        marketId: created.market.id,
        OR: [
          { reservedPrincipalMilli: { gt: 0n } },
          { reservedFeeMilli: { gt: 0n } },
          { reservedYesQuantity: { gt: 0 } },
          { reservedNoQuantity: { gt: 0 } },
        ],
      },
    }),
  ]);
  assert(yesAfterClose.balanceMilli === yesAfterMatch.balanceMilli, `${outcome} close changed the share seller's cash`);
  assert(noAfterClose.balanceMilli === noAfterMatch.balanceMilli, `${outcome} close did not refund reserved cash exactly`);
  assert(positionAfterClose.reservedYesShares === 0, `${outcome} close did not release reserved YES shares`);
  assert(openOrders === 0 && liveReservations === 0, `${outcome} admin close did not fully drain the order book`);

  return {
    outcome,
    marketId: created.market.id,
    marketSlug: definition.slug,
    yesParticipant,
    noParticipant,
    yesBalanceBeforeSettlement: yesAfterClose.balanceMilli,
    noBalanceBeforeSettlement: noAfterClose.balanceMilli,
  };
}

async function settleScenario(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  proposerId: string,
  approverId: string,
) {
  const label = scenario.outcome.toLowerCase();
  const proposal = await createResolutionProposal({
    actorUserId: proposerId,
    marketId: scenario.marketId,
    idempotencyKey: `propose-${label}-${suffix}`,
    resolution: {
      outcome: scenario.outcome,
      reason: `The deterministic ${scenario.outcome} fixture reached its declared outcome.`,
      evidence: `orderbook-settlement-e2e:${suffix}:${label}`,
    },
  });
  const approval = await approveResolutionProposal({
    actorUserId: approverId,
    proposalId: proposal.proposal.id,
    idempotencyKey: `approve-${label}-${suffix}`,
  });
  assert(approval.run.totalPositions === 2, `${scenario.outcome} settlement did not snapshot both positions`);

  async function equitySnapshot() {
    return runSerializableTransaction(db, async (tx) => {
      const ids = [scenario.yesParticipant.id, scenario.noParticipant.id];
      const users = await tx.user.findMany({ where: { id: { in: ids } } });
      const positions = await tx.position.findMany({ where: { marketId: scenario.marketId }, include: { market: true } });
      const values = await loadPositionValuations(tx, positions);
      return new Map(users.map((user) => [user.id, user.balanceMilli + positions
        .filter((position) => position.userId === user.id)
        .reduce((sum, position) => sum + values.get(position.id)!.valueMilli, 0n)]));
    });
  }
  const approvedEquity = await equitySnapshot();
  async function assertEquityPreserved(stage: string) {
    const current = await equitySnapshot();
    for (const [userId, equity] of approvedEquity) {
      assert(current.get(userId) === equity, `${scenario.outcome} equity changed during ${stage} instead of moving approved payout from holdings to cash`);
    }
  }

  const firstBatch = await processSettlementRun({
    actorUserId: approverId,
    runId: approval.run.id,
    batchSize: 1,
  });
  assert(
    firstBatch.run.status === "READY" && firstBatch.run.processedCount === 1,
    `${scenario.outcome} first settlement batch was not bounded to one position`,
  );
  await assertEquityPreserved("partial settlement");
  const finalBatch = await processSettlementRun({
    actorUserId: approverId,
    runId: approval.run.id,
    batchSize: 1,
  });
  assert(
    finalBatch.run.status === "COMPLETED" &&
      finalBatch.run.processedCount === 2 &&
      finalBatch.run.batchCount === 2 &&
      finalBatch.run.totalPayoutMilli === 200_000n,
    `${scenario.outcome} settlement did not complete in two exact batches`,
  );
  await assertEquityPreserved("completed settlement");
  const replay = await processSettlementRun({
    actorUserId: approverId,
    runId: approval.run.id,
    batchSize: 1,
  });
  assert(replay.replayed, `${scenario.outcome} completed settlement did not replay safely`);

  const expectedBalances = scenario.outcome === "YES"
    ? { yes: 1_120_000n, no: 880_000n }
    : scenario.outcome === "NO"
      ? { yes: 920_000n, no: 1_080_000n }
      : { yes: 1_020_000n, no: 980_000n };
  const expectedPayouts = scenario.outcome === "YES"
    ? { yes: 200_000n, no: 0n }
    : scenario.outcome === "NO"
      ? { yes: 0n, no: 200_000n }
      : { yes: 100_000n, no: 100_000n };

  const [market, yesUser, noUser, positions, settlements, notifications, liveOrders, liveReservations] = await Promise.all([
    db.market.findUniqueOrThrow({
      where: { id: scenario.marketId },
      include: { collateralAccount: true },
    }),
    db.user.findUniqueOrThrow({ where: { id: scenario.yesParticipant.id } }),
    db.user.findUniqueOrThrow({ where: { id: scenario.noParticipant.id } }),
    db.position.findMany({ where: { marketId: scenario.marketId } }),
    db.positionSettlement.findMany({ where: { settlementRunId: approval.run.id } }),
    db.notification.findMany({
      where: {
        userId: { in: [scenario.yesParticipant.id, scenario.noParticipant.id] },
        type: "MARKET_RESOLVED",
        href: `/markets/${scenario.marketSlug}`,
      },
    }),
    db.marketOrder.count({
      where: {
        marketId: scenario.marketId,
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
      },
    }),
    db.orderReservation.count({
      where: {
        marketId: scenario.marketId,
        OR: [
          { reservedPrincipalMilli: { gt: 0n } },
          { reservedFeeMilli: { gt: 0n } },
          { reservedYesQuantity: { gt: 0 } },
          { reservedNoQuantity: { gt: 0 } },
        ],
      },
    }),
  ]);

  assert(
    market.status === (scenario.outcome === "VOID" ? "VOID" : "RESOLVED") &&
      market.resolution === scenario.outcome,
    `${scenario.outcome} market did not reach its correct terminal state`,
  );
  assert(
    market.yesShares === 0 &&
      market.noShares === 0 &&
      market.collateralAccount.balanceMilli === 0n &&
      market.collateralAccount.status === "CLOSED",
    `${scenario.outcome} terminal market retained shares or collateral`,
  );
  assert(
    positions.every((position) =>
      position.yesShares === 0 &&
      position.noShares === 0 &&
      position.reservedYesShares === 0 &&
      position.reservedNoShares === 0 &&
      position.netCostMilli === 0n
    ),
    `${scenario.outcome} terminal positions retained shares, reservations, or basis`,
  );
  assert(liveOrders === 0 && liveReservations === 0, `${scenario.outcome} terminal order book retained active reservations`);
  assert(
    yesUser.balanceMilli === expectedBalances.yes &&
      noUser.balanceMilli === expectedBalances.no &&
      yesUser.balanceMilli === scenario.yesBalanceBeforeSettlement + expectedPayouts.yes &&
      noUser.balanceMilli === scenario.noBalanceBeforeSettlement + expectedPayouts.no,
    `${scenario.outcome} settlement or reserve refund produced incorrect net wallets`,
  );
  assert(
    settlements.length === 2 &&
      settlements.find((settlement) => settlement.userId === yesUser.id)?.payoutMilli === expectedPayouts.yes &&
      settlements.find((settlement) => settlement.userId === noUser.id)?.payoutMilli === expectedPayouts.no,
    `${scenario.outcome} durable settlement payouts were not exact`,
  );
  assert(notifications.length === 2, `${scenario.outcome} settlement notifications were not exactly once per participant`);
  assert(
    await db.positionSettlement.count({ where: { settlementRunId: approval.run.id } }) === 2,
    `${scenario.outcome} settlement replay duplicated durable settlement rows`,
  );
}

async function main() {
  const creator = await createAdmin("creator");
  const proposer = await createAdmin("proposer");
  const approver = await createAdmin("approver");

  const scenarios = [];
  for (const outcome of ["YES", "NO", "VOID"] as const) {
    scenarios.push(await createScenario(outcome, creator.id));
  }

  for (const scenario of scenarios) {
    await settleScenario(scenario, proposer.id, approver.id);
  }

  const [proposerExposure, approverExposure, journals] = await Promise.all([
    db.orderFill.count({
      where: {
        OR: [
          { makerOrder: { is: { userId: proposer.id } } },
          { takerOrder: { is: { userId: proposer.id } } },
        ],
      },
    }),
    db.orderFill.count({
      where: {
        OR: [
          { makerOrder: { is: { userId: approver.id } } },
          { takerOrder: { is: { userId: approver.id } } },
        ],
      },
    }),
    db.journalEntry.findMany({ include: { postings: true } }),
  ]);
  assert(proposer.id !== approver.id, "Resolution proposal and approval used the same administrator");
  assert(proposerExposure === 0 && approverExposure === 0, "A resolution administrator had CLOB exposure");
  assert(
    journals.every(
      (journal) =>
        journal.postings.length >= 2 &&
        journal.postings.every((posting) => posting.amountMilli !== 0n) &&
        journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) === 0n,
    ),
    "A financial journal was empty, zero-valued, or unbalanced",
  );

  console.log(JSON.stringify({
    ok: true,
    outcomes: scenarios.map((scenario) => scenario.outcome),
    markets: scenarios.length,
    journals: journals.length,
  }));
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
