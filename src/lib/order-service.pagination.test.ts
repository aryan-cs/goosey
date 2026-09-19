import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  prisma: { marketOrder: { findMany: mocks.findMany } },
}));

import { listUserOrders } from "./order-service";
import { decodeCursor } from "./serializers";

function order(id: string, createdAt: string) {
  const timestamp = new Date(createdAt);
  return {
    id,
    clientOrderId: `client_${id}`,
    outcome: "YES",
    action: "BUY",
    bookSide: "BUY",
    limitPriceMilli: 42_000n,
    originalQuantity: 10,
    remainingQuantity: 10,
    filledQuantity: 0,
    canceledQuantity: 0,
    status: "OPEN",
    timeInForce: "GTC",
    postOnly: false,
    selfTradePrevention: "CANCEL_AGGRESSOR",
    cumulativeFeeMilli: 0n,
    acceptedSequence: 1n,
    prioritySequence: 1n,
    version: 0,
    expiresAt: null,
    terminalReason: null,
    terminalAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    market: { slug: "fixture", title: "Fixture", payoutMilli: 100_000n },
  };
}

describe("private order history pagination", () => {
  beforeEach(() => mocks.findMany.mockReset());

  it("fetches one lookahead row and returns a cursor for the last visible order", async () => {
    mocks.findMany.mockResolvedValue([
      order("order_00000003", "2026-09-19T12:03:00.000Z"),
      order("order_00000002", "2026-09-19T12:02:00.000Z"),
      order("order_00000001", "2026-09-19T12:01:00.000Z"),
    ]);

    const result = await listUserOrders({ userId: "user_12345678", limit: 2 });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
    expect(result.orders.map((entry) => entry.orderId)).toEqual(["order_00000003", "order_00000002"]);
    expect(decodeCursor(result.nextCursor)).toEqual({
      createdAt: "2026-09-19T12:02:00.000Z",
      id: "order_00000002",
    });
  });

  it("applies a descending createdAt/id keyset and terminates on the final page", async () => {
    mocks.findMany.mockResolvedValue([
      order("order_00000001", "2026-09-19T12:01:00.000Z"),
    ]);
    const cursor = {
      createdAt: new Date("2026-09-19T12:02:00.000Z"),
      id: "order_00000002",
    };

    const result = await listUserOrders({ userId: "user_12345678", limit: 2, cursor });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: "user_12345678",
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      }),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    }));
    expect(result.orders.map((entry) => entry.orderId)).toEqual(["order_00000001"]);
    expect(result.nextCursor).toBeNull();
  });
});
