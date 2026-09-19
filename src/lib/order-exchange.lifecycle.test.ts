import { describe, expect, it, vi } from "vitest";

import { drainMarketOrderBook } from "./order-exchange";

const MARKET_ID = "market_lifecycle_123";

function cashOrder() {
  return {
    id: "order_cash_123",
    userId: "inactive_user_123",
    marketId: MARKET_ID,
    status: "OPEN",
    version: 2,
    remainingQuantity: 3,
    prioritySequence: 4n,
    reservation: {
      orderId: "order_cash_123",
      cashAccountId: "reserve_cash_123",
      reservedPrincipalMilli: 120_000n,
      reservedFeeMilli: 2_000n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
    },
  };
}

function shareOrder() {
  return {
    id: "order_shares_123",
    userId: "seller_user_123",
    marketId: MARKET_ID,
    status: "PARTIALLY_FILLED",
    version: 7,
    remainingQuantity: 2,
    prioritySequence: 9n,
    reservation: {
      orderId: "order_shares_123",
      cashAccountId: null,
      reservedPrincipalMilli: 0n,
      reservedFeeMilli: 0n,
      reservedYesQuantity: 2,
      reservedNoQuantity: 0,
    },
  };
}

function drainingTx() {
  const orders = [cashOrder(), shareOrder()];
  return {
    market: {
      findUnique: vi.fn().mockResolvedValue({
        id: MARKET_ID,
        executionBackend: "DATABASE",
        collateralAccountId: "collateral_lifecycle",
        pricingModel: "ORDER_BOOK",
        commandSequence: 12n,
        bookSequence: 30n,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    marketOrder: {
      findMany: vi.fn().mockResolvedValue(orders),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orderReservation: {
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
    },
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "inactive_user_123",
        status: "SUSPENDED",
        balanceMilli: 50_000n,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ledgerAccount: {
      upsert: vi.fn().mockResolvedValue({ id: "wallet_123", balanceMilli: 50_000n }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    journalEntry: {
      create: vi.fn().mockResolvedValue({ id: "release_journal_123" }),
    },
    position: {
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orderEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    orderCommand: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("order-book lifecycle drain", () => {
  it("records a sequenced lifecycle barrier even when the book is empty", async () => {
    const tx = drainingTx();
    tx.marketOrder.findMany.mockResolvedValue([]);

    await expect(drainMarketOrderBook(tx as never, {
      marketId: MARKET_ID,
      actorUserId: "system_actor_123",
      reason: "MARKET_CLOSED",
    })).resolves.toEqual({ canceledOrders: 0, canceledQuantity: 0, commandSequence: 13n });

    expect(tx.orderEvent.create).toHaveBeenCalledOnce();
    expect(tx.orderEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      type: "MARKET_LIFECYCLE_BARRIER",
      effectIndex: 0,
      eventSequence: 31n,
    }) });
    expect(tx.market.update).toHaveBeenCalledWith({
      where: { id: MARKET_ID },
      data: { bookSequence: { increment: 1n } },
    });
    expect(tx.orderCommand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      actorUserId: "system_actor_123",
      commandType: "LIFECYCLE",
      commandSequence: 13n,
      status: "COMPLETED",
    }) });
  });

  it("releases cash and share reservations and terminalizes orders in deterministic priority order", async () => {
    const tx = drainingTx();

    await expect(
      drainMarketOrderBook(tx as never, {
        marketId: MARKET_ID,
        actorUserId: "system_actor_123",
        reason: "MARKET_PAUSED",
      }),
    ).resolves.toEqual({ canceledOrders: 2, canceledQuantity: 5, commandSequence: 13n });

    expect(tx.marketOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ prioritySequence: "asc" }, { id: "asc" }],
    }));
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: "inactive_user_123" },
      data: { balanceMilli: { increment: 122_000n } },
    });
    expect(tx.position.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: "seller_user_123",
        marketId: MARKET_ID,
        reservedYesShares: { gte: 2 },
      }),
      data: {
        reservedYesShares: { decrement: 2 },
        reservedNoShares: { decrement: 0 },
      },
    }));

    expect(tx.marketOrder.updateMany.mock.calls.map(([call]) => call.where.id)).toEqual([
      "order_cash_123",
      "order_shares_123",
    ]);
    for (const [call] of tx.marketOrder.updateMany.mock.calls) {
      expect(call.data).toMatchObject({
        remainingQuantity: 0,
        status: "CANCELED",
        terminalSequence: 13n,
        terminalReason: "MARKET_PAUSED",
      });
    }
    expect(tx.orderEvent.create.mock.calls.map(([call]) => call.data)).toEqual([
      expect.objectContaining({
        commandSequence: 13n,
        eventSequence: 31n,
        effectIndex: 0,
        type: "MARKET_LIFECYCLE_BARRIER",
      }),
      expect.objectContaining({
        commandSequence: 13n,
        eventSequence: 32n,
        effectIndex: 1,
        payload: expect.stringContaining("order_cash_123"),
      }),
      expect.objectContaining({
        commandSequence: 13n,
        eventSequence: 33n,
        effectIndex: 2,
        payload: expect.stringContaining("order_shares_123"),
      }),
    ]);
    expect(tx.market.update).toHaveBeenCalledWith({
      where: { id: MARKET_ID },
      data: { bookSequence: { increment: 3n } },
    });
  });

  it("rejects orphaned reservations instead of silently completing a drain", async () => {
    const tx = drainingTx();
    tx.marketOrder.findMany.mockResolvedValue([]);
    tx.orderReservation.count.mockResolvedValue(1);

    await expect(
      drainMarketOrderBook(tx as never, {
        marketId: MARKET_ID,
        actorUserId: "system_actor_123",
        reason: "MARKET_CLOSED",
      }),
    ).rejects.toMatchObject({ status: 409, code: "ORDER_RESERVATION_ORPHANED" });

    expect(tx.market.updateMany).not.toHaveBeenCalled();
    expect(tx.marketOrder.updateMany).not.toHaveBeenCalled();
  });
});
