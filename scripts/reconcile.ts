import { db, requireDatabaseStartup } from "../src/lib/db";
import { assertDatabaseFinancialMarket } from "../src/lib/market-backend";
import {
  assertActiveReservationConsistency,
  assertOrderBookMarketAccounting,
  assertOrderQuantityConservation,
  assertPositionReservationConsistency,
  assertTerminalMarketHasNoActiveOrders,
  assertUniqueFillJournalLinkage,
} from "../src/lib/invariants";
import { requiredCollateralMilli } from "../src/lib/market-maker";
import { reconcileReservationCash } from "../src/lib/reservation-reconciliation";
import { readReconciliationSnapshot } from "../src/lib/reconciliation-snapshot";

async function main() {
  await requireDatabaseStartup();
  const errors: string[] = [];
  const { journals, accounts, users, markets } = await readReconciliationSnapshot(db);
  errors.push(...reconcileReservationCash(accounts, markets.flatMap((market) => market.orderReservations)));
  for (const journal of journals) {
    const sum = journal.postings.reduce((total, posting) => total + posting.amountMilli, 0n);
    if (sum !== 0n) errors.push(`journal ${journal.id} is unbalanced by ${sum}`);
  }
  for (const account of accounts) {
    const posted = account.postings.filter((posting) => posting.journalEntry.status === "POSTED").reduce((total, posting) => total + posting.amountMilli, 0n);
    if (posted !== account.balanceMilli) errors.push(`ledger account ${account.id} cache ${account.balanceMilli} != postings ${posted}`);
    if (!account.allowsNegative && account.balanceMilli < 0n) errors.push(`ledger account ${account.id} is negative`);
  }
  for (const user of users) {
    const wallet = accounts.find((account) => account.ownerType === "USER" && account.ownerId === user.id && account.purpose === "USER_FEATHERS");
    if (!wallet) errors.push(`user ${user.id} has no wallet`);
    else if (wallet.balanceMilli !== user.balanceMilli) errors.push(`user ${user.id} cache does not match wallet`);
  }
  for (const market of markets) {
    assertDatabaseFinancialMarket(market);
    const yes = market.positions.reduce((total, position) => total + position.yesShares, 0);
    const no = market.positions.reduce((total, position) => total + position.noShares, 0);
    if (yes !== market.yesShares || no !== market.noShares) errors.push(`market ${market.id} share totals do not match positions`);
    for (const order of market.orders) {
      try {
        assertOrderQuantityConservation(order);
      } catch (error) {
        errors.push(`order ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        assertActiveReservationConsistency(order, order.reservation);
      } catch (error) {
        errors.push(`order ${order.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const position of market.positions) {
      try {
        assertPositionReservationConsistency(position, market.orderReservations);
      } catch (error) {
        errors.push(`position ${position.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const reservation of market.orderReservations) {
      if (reservation.reservedYesQuantity === 0 && reservation.reservedNoQuantity === 0) continue;
      const position = market.positions.find((candidate) => candidate.userId === reservation.userId);
      if (!position) {
        errors.push(`reservation ${reservation.orderId} reserves shares without a position`);
      }
    }
    try {
      assertUniqueFillJournalLinkage(market.orderFills);
    } catch (error) {
      errors.push(`market ${market.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      assertTerminalMarketHasNoActiveOrders({
        status: market.status,
        orders: market.orders,
        reservations: market.orderReservations,
      });
    } catch (error) {
      errors.push(`market ${market.id}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (market.pricingModel === "ORDER_BOOK") {
      try {
        assertOrderBookMarketAccounting({
          yesShares: market.yesShares,
          noShares: market.noShares,
          payoutMilli: market.payoutMilli,
          collateralMilli: market.collateralAccount.balanceMilli,
        });
      } catch (error) {
        errors.push(`market ${market.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!["RESOLVED", "VOID"].includes(market.status)) {
      const required = requiredCollateralMilli({ yesQuantity: market.yesShares, noQuantity: market.noShares, liquidity: market.liquidityParameter, payoutMilli: market.payoutMilli });
      if (market.collateralAccount.balanceMilli < required) errors.push(`market ${market.id} collateral ${market.collateralAccount.balanceMilli} < required ${required}`);
    }
  }
  if (errors.length) {
    console.error(JSON.stringify({ ok: false, discrepancies: errors }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      ok: true,
      journals: journals.length,
      accounts: accounts.length,
      users: users.length,
      markets: markets.length,
      orders: markets.reduce((total, market) => total + market.orders.length, 0),
      reservations: markets.reduce((total, market) => total + market.orderReservations.length, 0),
      orderFills: markets.reduce((total, market) => total + market.orderFills.length, 0),
    }));
  }
}

main().finally(() => db.$disconnect());
