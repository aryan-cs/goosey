import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  tx: undefined as unknown,
}));

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly details?: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    consumeRateLimit: vi.fn().mockResolvedValue(undefined),
    prisma: {
      $transaction: (...args: unknown[]) => {
        mocks.transaction(...args);
        const callback = args.find((value): value is (tx: unknown) => unknown => typeof value === "function");
        if (!callback) throw new TypeError("transaction callback missing");
        return callback(mocks.tx);
      },
    },
  };
});

import { processClaimedBatch } from "./settlement-service";

function settlementTx(liveOrders: number, liveReservations: number) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({ role: "SYSTEM", status: "ACTIVE" }),
    },
    marketSettlementRun: {
      findUnique: vi.fn().mockResolvedValue({
        id: "run_orderbook_123",
        marketId: "market_orderbook_123",
        proposalId: "proposal_123",
        outcome: "YES",
        status: "RUNNING",
        claimToken: "claim_token_123",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        market: {
          id: "market_orderbook_123",
          status: "RESOLVING",
          resolution: "YES",
          pricingModel: "ORDER_BOOK",
        },
      }),
    },
    marketOrder: { count: vi.fn().mockResolvedValue(liveOrders) },
    orderReservation: { count: vi.fn().mockResolvedValue(liveReservations) },
    position: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn() },
  };
}

describe("order-book settlement guard", () => {
  beforeEach(() => mocks.transaction.mockReset());

  it.each([
    { label: "a live order", liveOrders: 1, liveReservations: 0 },
    { label: "a live reservation", liveOrders: 0, liveReservations: 1 },
  ])("refuses settlement while $label remains", async ({ liveOrders, liveReservations }) => {
    const tx = settlementTx(liveOrders, liveReservations);
    mocks.tx = tx;

    await expect(processClaimedBatch({
      actorUserId: "system_user_123",
      runId: "run_orderbook_123",
      claimToken: "claim_token_123",
      batchSize: 25,
    })).rejects.toMatchObject({ status: 409, code: "ORDER_BOOK_NOT_DRAINED" });

    expect(tx.marketOrder.count).toHaveBeenCalledWith({
      where: {
        marketId: "market_orderbook_123",
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        remainingQuantity: { gt: 0 },
      },
    });
    expect(tx.orderReservation.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ marketId: "market_orderbook_123" }),
    }));
    expect(tx.position.findMany).not.toHaveBeenCalled();
  });
});
