import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import { ApiError } from "../src/lib/market-service";
import { listUserFills, parseListFillsQuery } from "../src/lib/fill-service";
import { cancelAllOrders, cancelOrder, expireOrders, placeOrder, replaceOrder } from "../src/lib/order-exchange";
import { listUserOrders, parseListOrdersQuery } from "../src/lib/order-service";

const db = new PrismaClient();
const suffix = randomUUID().slice(0, 8);
const payoutMilli = 100_000n;

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
  const balanceMilli = role === "USER" ? 1_000_000n : 0n;
  const user = await db.user.create({
    data: {
      email: `${label}-${suffix}@goosey.test`,
      username: `${label}_${suffix}`,
      displayName: `${label} order-book fixture`,
      passwordHash: "isolated-order-book-test-only",
      role,
      emailVerifiedAt: new Date(),
      balanceMilli,
    },
  });
  if (role === "USER") {
    await db.ledgerAccount.create({
      data: {
        ownerType: "USER",
        ownerId: user.id,
        purpose: "USER_FEATHERS",
        balanceMilli,
      },
    });
  }
  return user;
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
      priceHistory: { create: { yesProbabilityBps: 5_000 } },
    },
  });
  await db.ledgerAccount.update({ where: { id: collateral.id }, data: { ownerId: market.id } });

  const aliceKey = `alice-place-${suffix}`;
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
  const resting = await db.marketOrder.findUniqueOrThrow({
    where: { userId_clientOrderId: { userId: alice.id, clientOrderId: `alice-client-${suffix}` } },
    include: { reservation: true },
  });
  assert(resting.status === "OPEN" && resting.reservation?.reservedPrincipalMilli === 400_000n, "Alice resting order/reservation is incorrect");

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

  await placeOrder({
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
  });

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
  assert(snapshots.length === 2 && snapshots.at(-1)?.yesProbabilityBps === 4_000, "Final fill did not append the actual 40% history point");

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

  const bulkCancelInput = {
    userId: alice.id,
    idempotencyKey: `alice-bulk-cancel-${suffix}`,
    request: { marketSlug: market.slug },
  };
  const bulkCanceled = await cancelAllOrders(bulkCancelInput) as { canceledCount: number; canceledQuantity: number };
  const bulkReplay = await cancelAllOrders(bulkCancelInput);
  assert(JSON.stringify(bulkCanceled) === JSON.stringify(bulkReplay), "Bulk cancellation replay changed its response");
  assert(bulkCanceled.canceledCount === 2 && bulkCanceled.canceledQuantity === 3, "Bulk cancellation missed Alice's live orders");
  const aliceLiveOrders = await db.marketOrder.count({
    where: { userId: alice.id, status: { in: ["OPEN", "PARTIALLY_FILLED"] }, remainingQuantity: { gt: 0 } },
  });
  assert(aliceLiveOrders === 0, "Bulk cancellation left an Alice order live");

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

main()
  .finally(() => db.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
