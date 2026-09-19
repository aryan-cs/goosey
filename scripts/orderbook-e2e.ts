import { randomUUID } from "node:crypto";

import { db, databaseRuntime } from "../src/lib/db";

import { ApiError } from "../src/lib/market-service";
import { createAdminMarket, createMarketSchema } from "../src/lib/admin-service";
import { grantWelcomeFeathers, welcomeGrantMilliFromEnvironment } from "../src/lib/auth";
import { getLeaderboardRows } from "../src/lib/leaderboard";
import { loadMarketMarks } from "../src/lib/market-marks";
import { loadPositionValuations } from "../src/lib/position-valuation";
import { loadTradeHistory, parseTradeHistoryCursor } from "../src/lib/trade-history";
import { listPublicTrades, listUserFills, parseListFillsQuery } from "../src/lib/fill-service";
import { cancelAllOrders, cancelOrder, expireOrders, placeOrder, replaceOrder } from "../src/lib/order-exchange";
import { getPublicOrderBook, listUserOrders, parseListOrdersQuery } from "../src/lib/order-service";

const suffix = randomUUID().slice(0, 8);
const payoutMilli = 100_000n;
const fixtureFundingMilli = 1_000_000n;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectApiError(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof ApiError && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code}`);
}

async function createUser(label: string, role = "USER") {
  return db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: `${label}-${suffix}@goosey.test`,
        username: `${label}_${suffix}`,
        displayName: `${label} order-book fixture`,
        passwordHash: "isolated-order-book-test-only",
        role,
        leaderboardVisible: role === "USER",
        emailVerifiedAt: new Date(),
      },
    });
    if (role !== "USER") return user;

    let configuredWelcomeGrantMilli: bigint | null = null;
    try {
      configuredWelcomeGrantMilli = welcomeGrantMilliFromEnvironment();
    } catch {
      // A fixture grant remains explicit and ledger-backed even if the runtime
      // welcome-grant configuration is intentionally unavailable or invalid.
    }
    if (
      configuredWelcomeGrantMilli === fixtureFundingMilli &&
      await grantWelcomeFeathers(tx, user.id)
    ) {
      return tx.user.findUniqueOrThrow({ where: { id: user.id } });
    }

    const source = await tx.ledgerAccount.create({
      data: {
        ownerType: "SYSTEM",
        ownerId: `orderbook-e2e:${suffix}:${label}`,
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
        idempotencyScope: "ORDERBOOK_E2E_FIXTURE",
        idempotencyKey: `${suffix}:${label}`,
        actorUserId: user.id,
        metadata: JSON.stringify({ amountMilli: fixtureFundingMilli.toString() }),
        postings: {
          create: [
            { ledgerAccountId: source.id, amountMilli: -fixtureFundingMilli },
            { ledgerAccountId: wallet.id, amountMilli: fixtureFundingMilli },
          ],
        },
      },
    });
    await Promise.all([
      tx.ledgerAccount.update({
        where: { id: source.id },
        data: { balanceMilli: { decrement: fixtureFundingMilli } },
      }),
      tx.ledgerAccount.update({
        where: { id: wallet.id },
        data: { balanceMilli: { increment: fixtureFundingMilli } },
      }),
      tx.user.update({
        where: { id: user.id },
        data: { balanceMilli: { increment: fixtureFundingMilli } },
      }),
    ]);
    return tx.user.findUniqueOrThrow({ where: { id: user.id } });
  });
}

async function main() {
  const [creator, alice, bob, carol] = await Promise.all([
    createUser("creator", "ADMIN"),
    createUser("alice"),
    createUser("bob"),
    createUser("carol"),
  ]);
  const collateral = await db.ledgerAccount.create({
    data: { ownerType: "MARKET", purpose: "COLLATERAL", balanceMilli: 0n },
  });
  const market = await db.market.create({
    data: {
      slug: `order-book-${suffix}`,
      title: "Will the isolated Goosey order book conserve every feather?",
      shortTitle: "Order-book conservation",
      description: "An isolated integration market for exact CLOB accounting.",
      rules: "Resolves only inside this disposable integration database.",
      resolutionSource: "Goosey order-book integration runner",
      category: "Testing",
      status: "OPEN",
      closesAt: new Date(Date.now() + 3_600_000),
      resolvesAt: new Date(Date.now() + 7_200_000),
      payoutMilli,
      feeBps: 0,
      pricingModel: "ORDER_BOOK",
      createdById: creator.id,
      collateralAccountId: collateral.id,
    },
  });
  await db.ledgerAccount.update({ where: { id: collateral.id }, data: { ownerId: market.id } });

  const aliceKey = `alice-place-${suffix}`;
  const aliceEquityBeforeReserve = (await getLeaderboardRows()).find((row) => row.userId === alice.id)?.equityMilli;
  assert(aliceEquityBeforeReserve === 1_000_000n, "Initial leaderboard equity did not match funded cash");
  const aliceOrder = await placeOrder({
    userId: alice.id,
    idempotencyKey: aliceKey,
    request: {
      marketId: market.id,
      clientOrderId: `alice-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "40000",
      quantity: 10,
      timeInForce: "GTC",
    },
  });
  assert((aliceOrder as { accepted?: boolean }).accepted === true, "Alice order was not accepted");

  const aliceAfterReserve = await db.user.findUniqueOrThrow({ where: { id: alice.id } });
  assert(aliceAfterReserve.balanceMilli === 600_000n, "Alice cash reserve was not exact");
  const aliceRankingWithReserve = (await getLeaderboardRows()).find((row) => row.userId === alice.id);
  assert(aliceRankingWithReserve?.equityMilli === aliceEquityBeforeReserve && aliceRankingWithReserve.reservedCashMilli === 400_000n, "Resting order reduced leaderboard equity instead of moving cash into escrow");
  assert(aliceRankingWithReserve.trades === 0 && aliceRankingWithReserve.marketsTraded === 0, "An unfilled order counted as trading activity");
  const resting = await db.marketOrder.findUniqueOrThrow({
    where: { userId_clientOrderId: { userId: alice.id, clientOrderId: `alice-client-${suffix}` } },
    include: { reservation: true },
  });
  assert(resting.status === "OPEN" && resting.reservation?.reservedPrincipalMilli === 400_000n, "Alice resting order/reservation is incorrect");
  assert(
    await db.notification.count({ where: { userId: alice.id, type: "TRADE_CONFIRMED" } }) === 0,
    "A resting order emitted a trade notification before any fill committed",
  );

  const replay = await placeOrder({
    userId: alice.id,
    idempotencyKey: aliceKey,
    request: {
      marketId: market.id,
      clientOrderId: `alice-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "40000",
      quantity: 10,
      timeInForce: "GTC",
    },
  });
  assert(JSON.stringify(replay) === JSON.stringify(aliceOrder), "Placement replay changed its response");
  assert(
    await db.notification.count({ where: { userId: alice.id, type: "TRADE_CONFIRMED" } }) === 0,
    "Replaying a resting order emitted a trade notification",
  );
  await expectApiError(
    () => placeOrder({
      userId: alice.id,
      idempotencyKey: aliceKey,
      request: {
        marketId: market.id,
        clientOrderId: `alice-client-${suffix}`,
        outcome: "YES",
        action: "BUY",
        limitPriceMilli: "41000",
        quantity: 10,
        timeInForce: "GTC",
      },
    }),
    "IDEMPOTENCY_CONFLICT",
  );

  const bobInitialFillInput = {
    userId: bob.id,
    idempotencyKey: `bob-place-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `bob-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: 10,
      timeInForce: "GTC",
    },
  };
  const notificationAbortTrigger = `orderbook_notification_abort_${suffix}`;
  const [aliceBeforeAbortedFill, bobBeforeAbortedFill, restingBeforeAbortedFill, marketBeforeAbortedFill, ordersBeforeAbortedFill, fillsBeforeAbortedFill] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: alice.id } }),
    db.user.findUniqueOrThrow({ where: { id: bob.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: resting.id }, include: { reservation: true } }),
    db.market.findUniqueOrThrow({ where: { id: market.id }, include: { collateralAccount: true } }),
    db.marketOrder.count({ where: { marketId: market.id } }),
    db.orderFill.count({ where: { marketId: market.id } }),
  ]);
  let notificationAbortRejectedFill = false;
  const journalsBeforeAbortedFill = await db.journalEntry.count();
  if (databaseRuntime.provider === "postgresql") {
    await db.$executeRawUnsafe(`CREATE FUNCTION "${notificationAbortTrigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'orderbook notification rollback regression' USING ERRCODE = '23503'; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${notificationAbortTrigger}" BEFORE INSERT ON "Notification" FOR EACH ROW EXECUTE FUNCTION "${notificationAbortTrigger}"()`);
  } else {
    await db.$executeRawUnsafe(`CREATE TRIGGER "${notificationAbortTrigger}" BEFORE INSERT ON "Notification" BEGIN SELECT RAISE(ABORT, 'orderbook notification rollback regression'); END`);
  }
  try {
    await placeOrder(bobInitialFillInput);
  } catch (error) {
    assert(error instanceof Error && error.message.includes("notification.createMany"), "Crossing order failed before the injected notification-write failure");
    notificationAbortRejectedFill = true;
  } finally {
    if (databaseRuntime.provider === "postgresql") {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${notificationAbortTrigger}" ON "Notification"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${notificationAbortTrigger}"()`);
    } else {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${notificationAbortTrigger}"`);
    }
  }
  assert(notificationAbortRejectedFill, "Notification insertion failure did not reject the crossing order");
  assert(await db.journalEntry.count() === journalsBeforeAbortedFill, "Aborted fill left journal entries behind");
  assert(await db.position.count({ where: { marketId: market.id } }) === 0, "Aborted fill left participant positions behind");
  assert(await db.notification.count({ where: { userId: { in: [alice.id, bob.id] } } }) === 0, "Aborted fill left a notification behind");
  const [aliceAfterAbortedFill, bobAfterAbortedFill, restingAfterAbortedFill, marketAfterAbortedFill, ordersAfterAbortedFill, fillsAfterAbortedFill, failedCommandCount] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: alice.id } }),
    db.user.findUniqueOrThrow({ where: { id: bob.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: resting.id }, include: { reservation: true } }),
    db.market.findUniqueOrThrow({ where: { id: market.id }, include: { collateralAccount: true } }),
    db.marketOrder.count({ where: { marketId: market.id } }),
    db.orderFill.count({ where: { marketId: market.id } }),
    db.orderCommand.count({ where: { actorUserId: bob.id, idempotencyKey: bobInitialFillInput.idempotencyKey } }),
  ]);
  assert(
    aliceAfterAbortedFill.balanceMilli === aliceBeforeAbortedFill.balanceMilli &&
      bobAfterAbortedFill.balanceMilli === bobBeforeAbortedFill.balanceMilli &&
      restingAfterAbortedFill.status === restingBeforeAbortedFill.status &&
      restingAfterAbortedFill.remainingQuantity === restingBeforeAbortedFill.remainingQuantity &&
      restingAfterAbortedFill.filledQuantity === restingBeforeAbortedFill.filledQuantity &&
      restingAfterAbortedFill.reservation?.reservedPrincipalMilli === restingBeforeAbortedFill.reservation?.reservedPrincipalMilli &&
      restingAfterAbortedFill.reservation?.reservedFeeMilli === restingBeforeAbortedFill.reservation?.reservedFeeMilli &&
      marketAfterAbortedFill.yesShares === marketBeforeAbortedFill.yesShares &&
      marketAfterAbortedFill.noShares === marketBeforeAbortedFill.noShares &&
      marketAfterAbortedFill.commandSequence === marketBeforeAbortedFill.commandSequence &&
      marketAfterAbortedFill.bookSequence === marketBeforeAbortedFill.bookSequence &&
      marketAfterAbortedFill.tradeSequence === marketBeforeAbortedFill.tradeSequence &&
      marketAfterAbortedFill.collateralAccount.balanceMilli === marketBeforeAbortedFill.collateralAccount.balanceMilli &&
      ordersAfterAbortedFill === ordersBeforeAbortedFill &&
      fillsAfterAbortedFill === fillsBeforeAbortedFill &&
      failedCommandCount === 0,
    "Failed notification persistence left committed order-book or accounting effects",
  );
  const bobInitialFill = await placeOrder(bobInitialFillInput);
  const initialNotificationsBeforeReplay = await db.notification.findMany({
    where: { userId: { in: [alice.id, bob.id] }, type: "TRADE_CONFIRMED" },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });
  const bobInitialFillReplay = await placeOrder(bobInitialFillInput);
  const initialNotificationsAfterReplay = await db.notification.findMany({
    where: { userId: { in: [alice.id, bob.id] }, type: "TRADE_CONFIRMED" },
    orderBy: [{ userId: "asc" }, { id: "asc" }],
  });
  assert(JSON.stringify(bobInitialFillReplay) === JSON.stringify(bobInitialFill), "Fill placement replay changed its response");
  const firstFillRankings = await getLeaderboardRows();
  for (const userId of [alice.id, bob.id]) {
    const row = firstFillRankings.find((entry) => entry.userId === userId);
    assert(row?.trades === 1 && row.marketsTraded === 1, "Maker or taker execution missing from leaderboard activity, or duplicated by replay");
  }
  assert(
    initialNotificationsBeforeReplay.length === 2 &&
      JSON.stringify(initialNotificationsAfterReplay) === JSON.stringify(initialNotificationsBeforeReplay),
    "Fill placement replay duplicated or changed trade notifications",
  );

  const [state, alicePosition, bobPosition, fills, orders, snapshots] = await Promise.all([
    db.market.findUniqueOrThrow({ where: { id: market.id }, include: { collateralAccount: true } }),
    db.position.findUniqueOrThrow({ where: { userId_marketId: { userId: alice.id, marketId: market.id } } }),
    db.position.findUniqueOrThrow({ where: { userId_marketId: { userId: bob.id, marketId: market.id } } }),
    db.orderFill.findMany({ where: { marketId: market.id }, include: { journalEntry: { include: { postings: true } } } }),
    db.marketOrder.findMany({ where: { marketId: market.id }, include: { reservation: true } }),
    db.marketPriceSnapshot.findMany({ where: { marketId: market.id }, orderBy: { createdAt: "asc" } }),
  ]);
  assert(state.yesShares === 10 && state.noShares === 10, "Complete-set issuance is not equal");
  assert(state.collateralAccount.balanceMilli === 1_000_000n, "Mint collateral is not exact");
  assert(alicePosition.yesShares === 10 && bobPosition.noShares === 10, "Mint positions are incorrect");
  assert(fills.length === 1, "Expected one immutable fill");
  assert(fills[0]!.journalEntry.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) === 0n, "Fill journal is unbalanced");
  assert(orders.every((order) => order.status === "FILLED" && order.remainingQuantity === 0), "Filled orders remained live");
  assert(orders.every((order) => order.reservation?.reservedPrincipalMilli === 0n), "Filled cash remained reserved");
  const aliceInitialNotification = initialNotificationsAfterReplay.find((notification) => notification.userId === alice.id);
  const bobInitialNotification = initialNotificationsAfterReplay.find((notification) => notification.userId === bob.id);
  const initialExecutionAt = orders[0]?.terminalAt;
  assert(initialExecutionAt && orders.every((order) => order.terminalAt?.getTime() === initialExecutionAt.getTime()), "Initial fill orders disagree on execution time");
  assert(
    aliceInitialNotification?.title === "Bought 10 YES" &&
      aliceInitialNotification.body === `${market.shortTitle}: filled at 40 feathers per contract. Fee: 0 feathers.` &&
      aliceInitialNotification.href === `/markets/${market.slug}` &&
      aliceInitialNotification.createdAt.getTime() === initialExecutionAt.getTime(),
    "YES maker did not receive an exact own-side committed-fill notification",
  );
  assert(
    bobInitialNotification?.title === "Bought 10 NO" &&
      bobInitialNotification.body === `${market.shortTitle}: filled at 60 feathers per contract. Fee: 0 feathers.` &&
      bobInitialNotification.href === `/markets/${market.slug}` &&
      bobInitialNotification.createdAt.getTime() === initialExecutionAt.getTime(),
    "NO taker notification did not use the complemented own-side price",
  );
  assert(snapshots.length === 1 && snapshots[0]?.yesProbabilityBps === 4_000, "Fill history was not derived solely from the actual 40% execution");
  const publicTape = await listPublicTrades({ marketSlug: market.slug, limit: 10 });
  assert(publicTape.trades.length === 1, "Public trade tape omitted the fill");
  assert(publicTape.trades[0]!.yesProbabilityBps === 4_000, "Public trade tape returned the wrong execution probability");
  assert(!("makerOrderId" in publicTape.trades[0]!) && !("takerOrderId" in publicTape.trades[0]!), "Public trade tape leaked order identity");

  const cancelPlacement = await placeOrder({
    userId: alice.id,
    idempotencyKey: `alice-second-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `alice-second-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "30000",
      quantity: 2,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string } };
  const cancelKey = `cancel-${suffix}`;
  const canceled = await cancelOrder({
    userId: alice.id,
    idempotencyKey: cancelKey,
    request: { orderId: cancelPlacement.order.orderId },
  });
  const canceledReplay = await cancelOrder({
    userId: alice.id,
    idempotencyKey: cancelKey,
    request: { orderId: cancelPlacement.order.orderId },
  });
  assert(JSON.stringify(canceled) === JSON.stringify(canceledReplay), "Cancel replay changed its response");
  const canceledOrder = await db.marketOrder.findUniqueOrThrow({
    where: { id: cancelPlacement.order.orderId },
    include: { reservation: true },
  });
  assert(canceledOrder.status === "CANCELED" && canceledOrder.reservation?.reservedPrincipalMilli === 0n, "Cancellation stranded a reservation");

  const expiresAt = new Date(Date.now() + 60_000);
  const expiringPlacement = await placeOrder({
    userId: alice.id,
    idempotencyKey: `alice-expiring-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `alice-expiring-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "25000",
      quantity: 1,
      timeInForce: "GTC",
      expiresAt: expiresAt.toISOString(),
    },
  }) as { order: { orderId: string; expiresAt: string } };
  assert(new Date(expiringPlacement.order.expiresAt).getTime() === expiresAt.getTime(), "Expiration was omitted from the order response");
  // Simulate elapsed time with a delayed cleanup worker, without sleeping.
  const overdue = await db.marketOrder.update({ where: { id: expiringPlacement.order.orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const depthBeforeCleanup = await getPublicOrderBook(market.slug, 20);
  assert(depthBeforeCleanup.bids.length === 0, "Public depth advertised an expired order before worker cleanup");
  const lateCross = await placeOrder({ userId: bob.id, idempotencyKey: `late-cross-${suffix}`, request: {
    marketId: market.id, clientOrderId: `late-cross-client-${suffix}`, outcome: "NO", action: "BUY", limitPriceMilli: "75000", quantity: 1, timeInForce: "IOC",
  } }) as { fills: unknown[] };
  assert(lateCross.fills.length === 0, "Placement executed against an expired maker before worker cleanup");
  await expectApiError(() => replaceOrder({ userId: alice.id, idempotencyKey: `expired-replace-${suffix}`, request: {
    orderId: overdue.id, expectedVersion: overdue.version, clientOrderId: `expired-replace-client-${suffix}`, limitPriceMilli: "25000", quantity: 1, expiresAt: null,
  } }), "ORDER_EXPIRED");
  const liveBob = await placeOrder({ userId: bob.id, idempotencyKey: `replace-against-expiry-${suffix}`, request: {
    marketId: market.id, clientOrderId: `replace-against-expiry-client-${suffix}`, outcome: "NO", action: "BUY", limitPriceMilli: "70000", quantity: 1, timeInForce: "GTC",
  } }) as { order: { orderId: string; version: number } };
  const lateReplacement = await replaceOrder({ userId: bob.id, idempotencyKey: `late-replace-${suffix}`, request: {
    orderId: liveBob.order.orderId, expectedVersion: liveBob.order.version, clientOrderId: `late-replace-client-${suffix}`, limitPriceMilli: "75000", quantity: 1,
  } }) as { fills: unknown[]; order: { orderId: string } };
  assert(lateReplacement.fills.length === 0, "Replacement executed against an expired maker before worker cleanup");
  await cancelOrder({ userId: bob.id, idempotencyKey: `late-replace-cancel-${suffix}`, request: { orderId: lateReplacement.order.orderId } });
  const expiration = await expireOrders(db, new Date(expiresAt.getTime() + 1));
  assert(expiration.expired === 1 && expiration.failures.length === 0, "Sequenced order expiration did not complete");
  const expiredOrder = await db.marketOrder.findUniqueOrThrow({
    where: { id: expiringPlacement.order.orderId },
    include: { reservation: true },
  });
  assert(
    expiredOrder.status === "CANCELED" &&
      expiredOrder.terminalReason === "ORDER_EXPIRED" &&
      expiredOrder.reservation?.reservedPrincipalMilli === 0n,
    "Order expiration stranded live quantity or backing",
  );
  const expirationEvent = await db.orderEvent.findFirst({
    where: { marketId: market.id, userId: alice.id, type: "ORDER_CANCELED", payload: { contains: "ORDER_EXPIRED" } },
  });
  assert(expirationEvent?.visibility === "PRIVATE", "Order expiration did not emit a private terminal event");

  const alicePriorityOrder = await placeOrder({
    userId: alice.id,
    idempotencyKey: `alice-priority-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `alice-priority-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "30000",
      quantity: 2,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string; version: number; prioritySequence: string } };
  const carolPriorityOrder = await placeOrder({
    userId: carol.id,
    idempotencyKey: `carol-priority-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `carol-priority-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "30000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string; prioritySequence: string } };
  const replaceKey = `alice-replace-${suffix}`;
  const replacementInput = {
    userId: alice.id,
    idempotencyKey: replaceKey,
    request: {
      orderId: alicePriorityOrder.order.orderId,
      expectedVersion: alicePriorityOrder.order.version,
      clientOrderId: `alice-replacement-client-${suffix}`,
      limitPriceMilli: "30000",
      quantity: 2,
    },
  };
  const replacement = await replaceOrder(replacementInput) as {
    accepted: boolean;
    replacedOrderId: string;
    order: { orderId: string; prioritySequence: string; version: number };
  };
  const replacementReplay = await replaceOrder(replacementInput);
  assert(JSON.stringify(replacement) === JSON.stringify(replacementReplay), "Replacement replay changed its response");
  assert(replacement.accepted && replacement.replacedOrderId === alicePriorityOrder.order.orderId, "Replacement did not identify its predecessor");
  assert(
    BigInt(replacement.order.prioritySequence) > BigInt(carolPriorityOrder.order.prioritySequence),
    "Replacement improperly retained the original order's queue priority",
  );

  await placeOrder({
    userId: bob.id,
    idempotencyKey: `bob-priority-cross-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `bob-priority-cross-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "70000",
      quantity: 1,
      timeInForce: "IOC",
    },
  });
  const priorityFill = await db.orderFill.findFirstOrThrow({
    where: { marketId: market.id, takerOrder: { clientOrderId: `bob-priority-cross-client-${suffix}` } },
  });
  assert(priorityFill.makerOrderId === carolPriorityOrder.order.orderId, "Replacement jumped ahead of an older same-price order");
  const [priorityOrders, priorityNotifications] = await Promise.all([
    db.marketOrder.findMany({ where: { id: { in: [priorityFill.makerOrderId, priorityFill.takerOrderId] } } }),
    db.notification.findMany({
      where: {
        type: "TRADE_CONFIRMED",
        OR: [
          { userId: carol.id, title: "Bought 1 YES" },
          { userId: bob.id, title: "Bought 1 NO" },
        ],
      },
    }),
  ]);
  const priorityExecutionAt = priorityOrders[0]?.terminalAt;
  const carolPriorityNotification = priorityNotifications.find((notification) => notification.userId === carol.id);
  const bobPriorityNotification = priorityNotifications.find((notification) => notification.userId === bob.id);
  assert(
    priorityOrders.length === 2 &&
      priorityExecutionAt &&
      priorityOrders.every((order) => order.terminalAt?.getTime() === priorityExecutionAt.getTime()),
    "Replacement-priority fill orders disagree on execution time",
  );
  assert(
    priorityNotifications.length === 2 &&
      carolPriorityNotification?.body === `${market.shortTitle}: filled at 30 feathers per contract. Fee: 0 feathers.` &&
      carolPriorityNotification.href === `/markets/${market.slug}` &&
      carolPriorityNotification.createdAt.getTime() === priorityExecutionAt.getTime() &&
      bobPriorityNotification?.body === `${market.shortTitle}: filled at 70 feathers per contract. Fee: 0 feathers.` &&
      bobPriorityNotification.href === `/markets/${market.slug}` &&
      bobPriorityNotification.createdAt.getTime() === priorityExecutionAt.getTime(),
    "Replacement-priority fill did not create exact notifications for both participants",
  );

  const [replacedOriginal, replacementRow, replacementReservation] = await Promise.all([
    db.marketOrder.findUniqueOrThrow({ where: { id: alicePriorityOrder.order.orderId } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: replacement.order.orderId } }),
    db.orderReservation.findUniqueOrThrow({ where: { orderId: replacement.order.orderId } }),
  ]);
  assert(replacedOriginal.status === "CANCELED" && replacedOriginal.terminalReason === "ORDER_REPLACED", "Original order was not terminally replaced");
  assert(replacementRow.replacedOrderId === replacedOriginal.id, "Replacement chain does not reference its predecessor");
  assert(replacementRow.orderChainId === replacedOriginal.orderChainId && replacementRow.replacementVersion === 1, "Replacement chain version is incorrect");
  assert(replacementReservation.reservedPrincipalMilli === 60_000n, "Replacement principal reservation is not exact");

  const opposingResting = await placeOrder({
    userId: bob.id,
    idempotencyKey: `bob-post-only-maker-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `bob-post-only-maker-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string } };
  assert(opposingResting.order.orderId.length > 0, "Opposing post-only test order was not accepted");
  const rejectedReplaceInput = {
    userId: alice.id,
    idempotencyKey: `alice-post-only-replace-${suffix}`,
    request: {
      orderId: replacement.order.orderId,
      expectedVersion: replacementRow.version,
      clientOrderId: `alice-post-only-replacement-client-${suffix}`,
      limitPriceMilli: "45000",
      quantity: 2,
      postOnly: true,
    },
  };
  const rejectedReplace = await replaceOrder(rejectedReplaceInput) as { accepted: boolean; reason: string };
  const rejectedReplay = await replaceOrder(rejectedReplaceInput);
  assert(JSON.stringify(rejectedReplace) === JSON.stringify(rejectedReplay), "Rejected replacement replay changed its response");
  assert(!rejectedReplace.accepted && rejectedReplace.reason === "POST_ONLY_WOULD_TRADE", "Crossing post-only replacement was not rejected");
  const preservedOriginal = await db.marketOrder.findUniqueOrThrow({
    where: { id: replacement.order.orderId },
    include: { reservation: true },
  });
  assert(preservedOriginal.status === "OPEN" && preservedOriginal.remainingQuantity === 2, "Rejected replacement modified the live original");
  assert(preservedOriginal.reservation?.reservedPrincipalMilli === 60_000n, "Rejected replacement changed the original reservation");

  const seenOrderIds = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = parseListOrdersQuery(new URLSearchParams({
      marketSlug: market.slug,
      limit: "1",
      ...(cursor ? { cursor } : {}),
    }));
    const page = await listUserOrders({ userId: alice.id, ...query });
    assert(page.orders.length === 1, "Private order history returned an unexpected page size");
    assert(!seenOrderIds.has(page.orders[0]!.orderId), "Private order history repeated an order across pages");
    seenOrderIds.add(page.orders[0]!.orderId);
    cursor = page.nextCursor;
  } while (cursor);
  assert(seenOrderIds.size === 5, "Private order history did not terminate after every Alice order");

  const expectedAliceFillCount = await db.orderFill.count({
    where: { OR: [{ makerOrder: { userId: alice.id } }, { takerOrder: { userId: alice.id } }] },
  });
  const seenFillIds = new Set<string>();
  cursor = null;
  do {
    const query = parseListFillsQuery(new URLSearchParams({
      marketSlug: market.slug,
      limit: "1",
      ...(cursor ? { cursor } : {}),
    }));
    const page = await listUserFills({ userId: alice.id, ...query });
    assert(page.fills.length === 1, "Private fill history returned an unexpected page size");
    const fill = page.fills[0]!;
    assert(!seenFillIds.has(fill.fillId), "Private fill history repeated a fill across pages");
    assert(fill.market.slug === market.slug && fill.executionPriceMilli > 0n, "Private fill serialization is incomplete");
    seenFillIds.add(fill.fillId);
    cursor = page.nextCursor;
  } while (cursor);
  assert(seenFillIds.size === expectedAliceFillCount, "Private fill history did not terminate after every Alice fill");

  await placeOrder({
    userId: alice.id,
    idempotencyKey: `alice-bulk-second-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `alice-bulk-second-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "20000",
      quantity: 1,
      timeInForce: "GTC",
    },
  });

  await placeOrder({
    userId: alice.id,
    idempotencyKey: `alice-bulk-share-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `alice-bulk-share-client-${suffix}`,
      outcome: "YES",
      action: "SELL",
      limitPriceMilli: "90000",
      quantity: 2,
      timeInForce: "GTC",
    },
  });

  const bobBulkGuard = await placeOrder({
    userId: bob.id,
    idempotencyKey: `bob-bulk-guard-${suffix}`,
    request: {
      marketId: market.id,
      clientOrderId: `bob-bulk-guard-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "10000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string } };

  const [bulkOrdersBefore, aliceBeforeBulk, alicePositionBeforeBulk, marketBeforeBulk] = await Promise.all([
    db.marketOrder.findMany({
      where: {
        userId: alice.id,
        marketId: market.id,
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
      },
      include: { reservation: true },
      orderBy: [{ prioritySequence: "asc" }, { id: "asc" }],
    }),
    db.user.findUniqueOrThrow({ where: { id: alice.id } }),
    db.position.findUniqueOrThrow({ where: { userId_marketId: { userId: alice.id, marketId: market.id } } }),
    db.market.findUniqueOrThrow({ where: { id: market.id } }),
  ]);
  const expectedBulkRefund = bulkOrdersBefore.reduce(
    (sum, order) => sum + (order.reservation?.reservedPrincipalMilli ?? 0n) + (order.reservation?.reservedFeeMilli ?? 0n),
    0n,
  );

  const bulkCancelInput = {
    userId: alice.id,
    idempotencyKey: `alice-bulk-cancel-${suffix}`,
    request: { marketSlug: market.slug },
  };
  const bulkCanceled = await cancelAllOrders(bulkCancelInput) as {
    canceledCount: number;
    canceledQuantity: number;
    orders: Array<{ orderId: string; canceledQuantity: number; commandSequence: string }>;
  };
  const [aliceAfterBulk, alicePositionAfterBulk, marketAfterBulk, canceledBulkOrders, bulkEvents, bulkCommand, journalCountAfterBulk] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: alice.id } }),
    db.position.findUniqueOrThrow({ where: { userId_marketId: { userId: alice.id, marketId: market.id } } }),
    db.market.findUniqueOrThrow({ where: { id: market.id } }),
    db.marketOrder.findMany({
      where: { id: { in: bulkOrdersBefore.map((order) => order.id) } },
      include: { reservation: true },
      orderBy: [{ prioritySequence: "asc" }, { id: "asc" }],
    }),
    db.orderEvent.findMany({
      where: {
        marketId: market.id,
        commandSequence: BigInt(bulkCanceled.orders[0]!.commandSequence),
        type: "ORDER_CANCELED",
      },
      orderBy: { effectIndex: "asc" },
    }),
    db.orderCommand.findUnique({
      where: {
        actorUserId_scope_idempotencyKey: {
          actorUserId: alice.id,
          scope: `ORDER_BULK_CANCEL:${market.id}`,
          idempotencyKey: bulkCancelInput.idempotencyKey,
        },
      },
    }),
    db.journalEntry.count(),
  ]);
  const bulkReplay = await cancelAllOrders(bulkCancelInput);
  assert(JSON.stringify(bulkCanceled) === JSON.stringify(bulkReplay), "Bulk cancellation replay changed its response");
  assert(bulkCanceled.canceledCount === 3 && bulkCanceled.canceledQuantity === 5, "Bulk cancellation missed Alice's live orders");
  assert(new Set(bulkCanceled.orders.map((order) => order.commandSequence)).size === 1, "Bulk cancellation consumed more than one market command");
  assert(marketAfterBulk.commandSequence === marketBeforeBulk.commandSequence + 1n, "Bulk cancellation did not advance the market command exactly once");
  assert(marketAfterBulk.bookSequence === marketBeforeBulk.bookSequence + BigInt(bulkOrdersBefore.length), "Bulk cancellation event sequence delta is incorrect");
  assert(
    canceledBulkOrders.every((order) =>
      order.status === "CANCELED" &&
      order.remainingQuantity === 0 &&
      order.terminalReason === "USER_BULK_CANCELED" &&
      order.terminalSequence === marketAfterBulk.commandSequence &&
      order.reservation?.reservedPrincipalMilli === 0n &&
      order.reservation.reservedFeeMilli === 0n &&
      order.reservation.reservedYesQuantity === 0 &&
      order.reservation.reservedNoQuantity === 0
    ),
    "Bulk cancellation left live quantity, backing, or inconsistent terminal sequencing",
  );
  assert(aliceAfterBulk.balanceMilli === aliceBeforeBulk.balanceMilli + expectedBulkRefund, "Bulk cancellation did not refund exact reserved cash");
  assert(
    alicePositionBeforeBulk.reservedYesShares === 2 &&
      alicePositionAfterBulk.reservedYesShares === 0 &&
      alicePositionAfterBulk.yesShares === alicePositionBeforeBulk.yesShares,
    "Bulk cancellation did not release exact reserved YES contracts",
  );
  assert(
    bulkEvents.length === bulkOrdersBefore.length &&
      bulkEvents.every((event, index) => event.effectIndex === index) &&
      bulkEvents.every((event, index) => event.eventSequence === marketBeforeBulk.bookSequence + BigInt(index + 1)),
    "Bulk cancellation events are not contiguous within one command",
  );
  assert(
    bulkCommand?.commandType === "BULK_CANCEL" &&
      bulkCommand.commandSequence === marketAfterBulk.commandSequence &&
      bulkCommand.status === "COMPLETED",
    "Bulk cancellation did not persist its sequenced command",
  );
  const aliceLiveOrders = await db.marketOrder.count({
    where: { userId: alice.id, status: { in: ["OPEN", "PARTIALLY_FILLED"] }, remainingQuantity: { gt: 0 } },
  });
  assert(aliceLiveOrders === 0, "Bulk cancellation left an Alice order live");
  const [bobGuardAfterBulk, marketAfterReplay, journalCountAfterReplay, bulkEventCountAfterReplay, bulkCommandCountAfterReplay] = await Promise.all([
    db.marketOrder.findUniqueOrThrow({ where: { id: bobBulkGuard.order.orderId }, include: { reservation: true } }),
    db.market.findUniqueOrThrow({ where: { id: market.id } }),
    db.journalEntry.count(),
    db.orderEvent.count({ where: { marketId: market.id, commandSequence: marketAfterBulk.commandSequence } }),
    db.orderCommand.count({ where: { marketId: market.id, commandSequence: marketAfterBulk.commandSequence } }),
  ]);
  assert(bobGuardAfterBulk.status === "OPEN" && bobGuardAfterBulk.reservation?.reservedPrincipalMilli === 10_000n, "Bulk cancellation affected another participant's order");
  assert(
    marketAfterReplay.commandSequence === marketAfterBulk.commandSequence &&
      marketAfterReplay.bookSequence === marketAfterBulk.bookSequence &&
      journalCountAfterReplay === journalCountAfterBulk &&
      bulkEventCountAfterReplay === bulkOrdersBefore.length &&
      bulkCommandCountAfterReplay === 1,
    "Bulk cancellation replay duplicated accounting or sequence effects",
  );
  await expectApiError(
    () => cancelAllOrders({ ...bulkCancelInput, request: {} }),
    "IDEMPOTENCY_CONFLICT",
  );

  await verifyIneligibleRestingMakers(creator.id);
  await verifyLiquidationAgainstActualSale(creator.id);
  await verifyAdminOrderBookCreation(creator.id);
  const journals = await db.journalEntry.findMany({ include: { postings: true } });
  assert(journals.every((journal) => journal.postings.length >= 2 && journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n) === 0n), "A journal failed reconciliation");

  console.log(JSON.stringify({
    ok: true,
    marketId: market.id,
    orders: await db.marketOrder.count({ where: { marketId: market.id } }),
    fills: fills.length,
    snapshots: snapshots.length,
    journals: journals.length,
  }));
}

async function verifyAdminOrderBookCreation(creatorId: string) {
  const definition = createMarketSchema.parse({
    slug: `admin-book-${suffix}`, title: "Will the newly created order book conserve feathers?", shortTitle: "Admin-created order book",
    description: "A disposable market created through the organizer service for integration testing.",
    rules: "Resolves only from the isolated integration test result.", resolutionSource: "Integration test output", category: "Testing",
    status: "OPEN", pricingModel: "ORDER_BOOK", feeBps: 100,
    closesAt: new Date(Date.now() + 3_600_000).toISOString(), resolvesAt: new Date(Date.now() + 7_200_000).toISOString(),
  });
  const treasuryBefore = await db.ledgerAccount.findMany({ where: { purpose: "TREASURY" } });
  const input = { actorUserId: creatorId, idempotencyKey: `admin-create-book-${suffix}`, market: definition };
  const created = await createAdminMarket(input);
  const replay = await createAdminMarket(input);
  assert(!created.replayed && replay.replayed && created.market.id === replay.market.id, "Admin order-book creation replay created another market");
  assert(created.subsidyMilli === 0n && replay.subsidyMilli === 0n, "Admin order-book creation issued an invented subsidy");
  await expectApiError(() => createAdminMarket({ ...input, market: { ...definition, pricingModel: "LMSR" } }), "IDEMPOTENCY_CONFLICT");
  const row = await db.market.findUniqueOrThrow({ where: { id: created.market.id }, include: { collateralAccount: true, _count: { select: { priceHistory: true, orders: true } } } });
  assert(row.pricingModel === "ORDER_BOOK" && row.collateralAccount?.balanceMilli === 0n && row._count.priceHistory === 0 && row._count.orders === 0, "New order book contains fabricated liquidity or price history");
  assert(await db.journalEntry.count({ where: { referenceId: row.id } }) === 0, "Empty order book created a financial journal without a transfer");
  assert(await db.auditLog.count({ where: { entityId: row.id, action: "MARKET_CREATED" } }) === 1, "Creation replay duplicated the audit record");
  const treasuryAfter = await db.ledgerAccount.findMany({ where: { purpose: "TREASURY" } });
  assert(treasuryBefore.length === treasuryAfter.length && treasuryBefore.reduce((sum, account) => sum + account.balanceMilli, 0n) === treasuryAfter.reduce((sum, account) => sum + account.balanceMilli, 0n), "Unfunded order-book creation changed treasury balances");
  const [yesBuyer, noBuyer] = await Promise.all([createUser("created_book_yes"), createUser("created_book_no")]);
  for (const [user, outcome, limitPriceMilli] of [[yesBuyer, "YES", "40000"], [noBuyer, "NO", "60000"]] as const) {
    await placeOrder({ userId: user.id, idempotencyKey: randomUUID(), request: { marketId: row.id, clientOrderId: randomUUID(), outcome, action: "BUY", limitPriceMilli, quantity: 2, timeInForce: "GTC" } });
  }
  const collateral = await db.ledgerAccount.findUniqueOrThrow({ where: { id: row.collateralAccountId! } });
  assert(collateral.balanceMilli === 200_000n && await db.orderFill.count({ where: { marketId: row.id } }) === 1, "Admin-created book could not mint fully participant-backed contracts");
}

async function verifyIneligibleRestingMakers(creatorId: string) {
  async function createMarket(label: string) {
    const collateral = await db.ledgerAccount.create({
      data: { ownerType: "MARKET", purpose: "COLLATERAL", balanceMilli: 0n },
    });
    const isolatedMarket = await db.market.create({
      data: {
        slug: `${label}-${suffix}`,
        title: `${label} resting-maker eligibility`,
        shortTitle: `${label} maker eligibility`,
        description: "Disposable resting-maker eligibility regression market.",
        rules: "Test only.",
        resolutionSource: "Order-book integration test",
        category: "Testing",
        status: "OPEN",
        pricingModel: "ORDER_BOOK",
        closesAt: new Date(Date.now() + 3_600_000),
        resolvesAt: new Date(Date.now() + 7_200_000),
        payoutMilli,
        feeBps: 0,
        createdById: creatorId,
        collateralAccountId: collateral.id,
      },
    });
    await db.ledgerAccount.update({ where: { id: collateral.id }, data: { ownerId: isolatedMarket.id } });
    return isolatedMarket;
  }

  const [suspendedMaker, suspendedCounterparty, adminMaker, replacementTrader, restoredCounterparty] = await Promise.all([
    createUser("eligibility_suspended_maker"),
    createUser("eligibility_suspended_counterparty"),
    createUser("eligibility_admin_maker"),
    createUser("eligibility_replacement_trader"),
    createUser("eligibility_restored_counterparty"),
  ]);
  const [suspendedMarket, adminMarket] = await Promise.all([
    createMarket("suspended-maker"),
    createMarket("admin-maker"),
  ]);

  const suspendedPlacement = await placeOrder({
    userId: suspendedMaker.id,
    idempotencyKey: `suspended-maker-place-${suffix}`,
    request: {
      marketId: suspendedMarket.id,
      clientOrderId: `suspended-maker-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "40000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string } };
  await db.user.update({ where: { id: suspendedMaker.id }, data: { status: "SUSPENDED" } });
  const [suspendedBeforeSkip, suspendedOrderBeforeSkip, suspendedDepth] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: suspendedMaker.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: suspendedPlacement.order.orderId }, include: { reservation: true } }),
    getPublicOrderBook(suspendedMarket.slug, 20),
  ]);
  assert(suspendedDepth.bids.length === 0 && suspendedDepth.asks.length === 0, "A suspended user's resting order leaked into public depth");
  await placeOrder({
    userId: suspendedCounterparty.id,
    idempotencyKey: `suspended-skip-cross-${suffix}`,
    request: {
      marketId: suspendedMarket.id,
      clientOrderId: `suspended-skip-cross-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: 1,
      timeInForce: "IOC",
    },
  });
  const [suspendedAfterSkip, suspendedOrderAfterSkip, suspendedSkippedFills] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: suspendedMaker.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: suspendedPlacement.order.orderId }, include: { reservation: true } }),
    db.orderFill.count({ where: { marketId: suspendedMarket.id } }),
  ]);
  assert(
    suspendedSkippedFills === 0 &&
      suspendedAfterSkip.balanceMilli === suspendedBeforeSkip.balanceMilli &&
      suspendedOrderAfterSkip.status === "OPEN" &&
      suspendedOrderAfterSkip.remainingQuantity === suspendedOrderBeforeSkip.remainingQuantity &&
      suspendedOrderAfterSkip.reservation?.reservedPrincipalMilli === suspendedOrderBeforeSkip.reservation?.reservedPrincipalMilli &&
      suspendedOrderAfterSkip.reservation?.reservedFeeMilli === suspendedOrderBeforeSkip.reservation?.reservedFeeMilli,
    "Placement matched or changed accounting for a suspended resting maker",
  );
  await db.user.update({ where: { id: suspendedMaker.id }, data: { status: "ACTIVE" } });
  await placeOrder({
    userId: suspendedCounterparty.id,
    idempotencyKey: `restored-suspended-cross-${suffix}`,
    request: {
      marketId: suspendedMarket.id,
      clientOrderId: `restored-suspended-cross-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: 1,
      timeInForce: "IOC",
    },
  });
  assert(
    await db.orderFill.count({ where: { marketId: suspendedMarket.id } }) === 1,
    "An active counterparty could not trade after the suspended maker was restored",
  );

  const adminPlacement = await placeOrder({
    userId: adminMaker.id,
    idempotencyKey: `admin-maker-place-${suffix}`,
    request: {
      marketId: adminMarket.id,
      clientOrderId: `admin-maker-client-${suffix}`,
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "30000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string } };
  await db.user.update({ where: { id: adminMaker.id }, data: { role: "ADMIN" } });
  const [adminBeforeSkip, adminOrderBeforeSkip, adminDepth] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: adminMaker.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: adminPlacement.order.orderId }, include: { reservation: true } }),
    getPublicOrderBook(adminMarket.slug, 20),
  ]);
  assert(adminBeforeSkip.status === "ACTIVE" && adminBeforeSkip.role === "ADMIN", "Admin-maker fixture did not retain active status");
  assert(adminDepth.bids.length === 0 && adminDepth.asks.length === 0, "An active admin's resting order leaked into public depth");

  const replacementOriginal = await placeOrder({
    userId: replacementTrader.id,
    idempotencyKey: `replacement-skip-original-${suffix}`,
    request: {
      marketId: adminMarket.id,
      clientOrderId: `replacement-skip-original-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "60000",
      quantity: 1,
      timeInForce: "GTC",
    },
  }) as { order: { orderId: string; version: number } };
  await replaceOrder({
    userId: replacementTrader.id,
    idempotencyKey: `replacement-skip-cross-${suffix}`,
    request: {
      orderId: replacementOriginal.order.orderId,
      expectedVersion: replacementOriginal.order.version,
      clientOrderId: `replacement-skip-cross-client-${suffix}`,
      limitPriceMilli: "70000",
      quantity: 1,
    },
  });
  const [adminAfterSkip, adminOrderAfterSkip, adminSkippedFills] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: adminMaker.id } }),
    db.marketOrder.findUniqueOrThrow({ where: { id: adminPlacement.order.orderId }, include: { reservation: true } }),
    db.orderFill.count({ where: { marketId: adminMarket.id } }),
  ]);
  assert(
    adminSkippedFills === 0 &&
      adminAfterSkip.balanceMilli === adminBeforeSkip.balanceMilli &&
      adminOrderAfterSkip.status === "OPEN" &&
      adminOrderAfterSkip.remainingQuantity === adminOrderBeforeSkip.remainingQuantity &&
      adminOrderAfterSkip.reservation?.reservedPrincipalMilli === adminOrderBeforeSkip.reservation?.reservedPrincipalMilli &&
      adminOrderAfterSkip.reservation?.reservedFeeMilli === adminOrderBeforeSkip.reservation?.reservedFeeMilli,
    "Replacement matched or changed accounting for an active admin resting maker",
  );
  await db.user.update({ where: { id: adminMaker.id }, data: { role: "USER" } });
  await placeOrder({
    userId: restoredCounterparty.id,
    idempotencyKey: `restored-admin-cross-${suffix}`,
    request: {
      marketId: adminMarket.id,
      clientOrderId: `restored-admin-cross-client-${suffix}`,
      outcome: "NO",
      action: "BUY",
      limitPriceMilli: "70000",
      quantity: 1,
      timeInForce: "IOC",
    },
  });
  assert(
    await db.orderFill.count({ where: { marketId: adminMarket.id } }) === 1,
    "An active counterparty could not trade after the admin maker returned to USER",
  );
}

async function verifyLiquidationAgainstActualSale(creatorId: string) {
  const [seller, oppositeBuyer, bidder] = await Promise.all([
    createUser("valuation_seller"), createUser("valuation_no"), createUser("valuation_bidder"),
  ]);
  const market = await db.market.create({ data: {
    slug: `valuation-${suffix}`, title: "Isolated liquidation valuation", shortTitle: "Liquidation valuation",
    description: "Disposable integration test", rules: "Test only", resolutionSource: "Test", category: "Testing",
    status: "OPEN", pricingModel: "ORDER_BOOK", closesAt: new Date(Date.now() + 3_600_000), resolvesAt: new Date(Date.now() + 7_200_000),
    payoutMilli, feeBps: 100, createdBy: { connect: { id: creatorId } },
    collateralAccount: { create: { ownerType: "MARKET", ownerId: `valuation-${suffix}`, purpose: "COLLATERAL" } },
  } });
  const emptyMarkMarket = await db.market.create({ data: {
    slug: `empty-mark-${suffix}`, title: "Isolated empty order-book mark", shortTitle: "Empty order-book mark",
    description: "Disposable mark integration test", rules: "Test only", resolutionSource: "Test", category: "Testing",
    status: "OPEN", pricingModel: "ORDER_BOOK", closesAt: new Date(Date.now() + 3_600_000), resolvesAt: new Date(Date.now() + 7_200_000),
    payoutMilli, feeBps: 0, createdBy: { connect: { id: creatorId } },
    collateralAccount: { create: { ownerType: "MARKET", ownerId: `empty-mark-${suffix}`, purpose: "COLLATERAL" } },
  } });
  async function place(userId: string, outcome: "YES" | "NO", action: "BUY" | "SELL", quantity: number, price: string) {
    return placeOrder({ userId, idempotencyKey: randomUUID(), request: { marketId: market.id, clientOrderId: randomUUID(), outcome, action, quantity, limitPriceMilli: price, timeInForce: "GTC" } });
  }
  await place(seller.id, "YES", "BUY", 10, "40000");
  await place(oppositeBuyer.id, "NO", "BUY", 10, "60000");
  async function valuation() {
    return db.$transaction(async (tx) => {
      const position = await tx.position.findUniqueOrThrow({ where: { userId_marketId: { userId: seller.id, marketId: market.id } }, include: { market: true } });
      return (await loadPositionValuations(tx, [position])).get(position.id)!;
    });
  }
  const withoutDepth = await valuation();
  assert(withoutDepth.valueMilli === 0n && withoutDepth.unfilledYes === 10, "Empty order book invented executable value");
  assert(withoutDepth.probabilityYesBps === 4000, "Order-book forecast ignored the real last fill");
  const initialMarks = await db.$transaction((tx) => loadMarketMarks(tx, [market, emptyMarkMarket]));
  const lastTradeMark = initialMarks.get(market.id);
  const emptyMark = initialMarks.get(emptyMarkMarket.id);
  assert(
    lastTradeMark?.source === "LAST" && lastTradeMark.probabilityYesBps === 4_000 && !lastTradeMark.stale,
    "Order-book mark did not use the actual 40% mint fill without quoted depth",
  );
  assert(
    emptyMark?.source === "NONE" && emptyMark.probabilityYesBps === null && !emptyMark.stale,
    "An empty isolated order book invented a probability mark",
  );
  await place(bidder.id, "YES", "BUY", 4, "30000");
  const quoted = await valuation();
  assert(quoted.valueMilli === 118_800n && quoted.unfilledYes === 6, "Valuation did not sweep available depth and subtract exact fees");
  await db.user.update({ where: { id: bidder.id }, data: { status: "SUSPENDED" } });
  const suspendedQuote = await valuation();
  assert(suspendedQuote.valueMilli === 0n && suspendedQuote.unfilledYes === 10, "Valuation counted liquidity from a suspended bidder");
  await db.user.update({ where: { id: bidder.id }, data: { status: "ACTIVE", role: "ADMIN" } });
  const privilegedQuote = await valuation();
  assert(privilegedQuote.valueMilli === 0n && privilegedQuote.unfilledYes === 10, "Valuation counted liquidity from a privileged bidder");
  await db.user.update({ where: { id: bidder.id }, data: { role: "USER" } });
  await place(seller.id, "YES", "SELL", 1, "35000");
  const midpointMark = (await db.$transaction((tx) => loadMarketMarks(tx, [market]))).get(market.id);
  assert(
    midpointMark?.source === "MID" && midpointMark.probabilityYesBps === 3_250 && !midpointMark.stale,
    "Qualified two-sided depth did not produce the actual 32.5% midpoint",
  );
  const before = await db.user.findUniqueOrThrow({ where: { id: seller.id } });
  await place(seller.id, "YES", "SELL", 4, "30000");
  const after = await db.user.findUniqueOrThrow({ where: { id: seller.id } });
  assert(after.balanceMilli - before.balanceMilli === quoted.valueMilli, "Estimated liquidation differs from actual matching-engine proceeds");
  const sellerRanking = (await getLeaderboardRows()).find((row) => row.userId === seller.id);
  assert(sellerRanking?.trades === 2 && sellerRanking.marketsTraded === 1, "Maker and taker executions in the same market were not counted correctly");
  // Equal timestamps exercise the stable cursor tie-break against real rows.
  await db.orderFill.updateMany({ where: { marketId: market.id }, data: { createdAt: new Date("2026-09-19T12:00:00Z") } });
  const first = await db.$transaction((tx) => loadTradeHistory(tx, seller.id, { limit: 1 }));
  assert(first.items.length === 1 && first.nextCursor, "Unified history omitted order-book executions or pagination");
  const second = await db.$transaction((tx) => loadTradeHistory(tx, seller.id, { limit: 1, cursor: parseTradeHistoryCursor(first.nextCursor!) }));
  assert(second.items.length === 1 && !second.nextCursor && first.items[0]!.id !== second.items[0]!.id, "Unified history repeated or lost equal-time executions");
  const sale = [...first.items, ...second.items].find((item) => item.action === "SELL")!;
  assert(sale.side === "YES" && sale.quantity === 4 && sale.amountMilli === 120_000n && sale.feeMilli === 1200n, "Unified history reported incorrect sale economics");
  const oppositeHistory = await db.$transaction((tx) => loadTradeHistory(tx, oppositeBuyer.id, { limit: 30 }));
  assert(oppositeHistory.items.length === 1 && oppositeHistory.items[0]!.side === "NO" && oppositeHistory.items[0]!.amountMilli === 600_000n, "Unified history leaked another participant's fills or mispriced NO contracts");
}

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
