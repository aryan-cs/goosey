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

import { listUserOrders, parseListOrdersQuery } from "./order-service";
import { decodeCursor } from "./serializers";

const USER_ID = "user_12345678";
const CREATED_AT = new Date("2026-09-19T12:00:00.000Z");

function order(
  id: string,
  overrides: Partial<ReturnType<typeof baseOrder>> = {},
) {
  return { ...baseOrder(id), ...overrides };
}

function baseOrder(id: string) {
  return {
    id,
    clientOrderId: `client_${id}`,
    outcome: "YES",
    action: "BUY",
    bookSide: "BUY",
    limitPriceMilli: 42_000n,
    originalQuantity: 10,
    remainingQuantity: 6,
    filledQuantity: 4,
    canceledQuantity: 0,
    status: "PARTIALLY_FILLED",
    timeInForce: "GTC",
    postOnly: false,
    selfTradePrevention: "CANCEL_AGGRESSOR",
    cumulativeFeeMilli: 168n,
    acceptedSequence: 7n,
    prioritySequence: 7n,
    version: 3,
    expiresAt: null,
    terminalReason: null,
    terminalAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    market: {
      slug: "goose-market",
      title: "Will the geese win?",
      payoutMilli: 100_000n,
    },
  };
}

describe("portfolio order activity", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
  });

  it("scopes active-order queries to the owner and requested live statuses", async () => {
    mocks.findMany.mockResolvedValue([]);
    const query = parseListOrdersQuery(
      new URLSearchParams("status=OPEN&status=PARTIALLY_FILLED&limit=25"),
    );

    await listUserOrders({ userId: USER_ID, ...query });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        status: { in: ["OPEN", "PARTIALLY_FILLED"] },
        market: { executionBackend: "DATABASE", collateralAccountId: { not: null }, pricingModel: "ORDER_BOOK" },
      },
      take: 26,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: expect.objectContaining({
        id: true,
        version: true,
        status: true,
        remainingQuantity: true,
        limitPriceMilli: true,
      }),
    });
  });

  it("keeps a NO order limit in persisted canonical-YES units and exposes cancel versioning", async () => {
    mocks.findMany.mockResolvedValue([
      order("order_00000003", {
        outcome: "NO",
        action: "BUY",
        bookSide: "SELL",
        limitPriceMilli: 72_000n,
        status: "OPEN",
        version: 5,
      }),
    ]);

    const result = await listUserOrders({
      userId: USER_ID,
      statuses: ["OPEN"],
      limit: 25,
    });

    expect(result.orders).toHaveLength(1);
    expect(result.orders[0]).toMatchObject({
      orderId: "order_00000003",
      outcome: "NO",
      bookSide: "SELL",
      limitPriceMilli: 72_000n,
      version: 5,
      market: { payoutMilli: 100_000n },
    });
    expect(result.nextCursor).toBeNull();
  });

  it("uses descending createdAt/id pagination without duplicate equal-time rows", async () => {
    const cursor = {
      createdAt: CREATED_AT,
      id: "order_00000003",
    };
    mocks.findMany.mockResolvedValue([
      order("order_00000002"),
      order("order_00000001"),
    ]);

    const result = await listUserOrders({
      userId: USER_ID,
      limit: 1,
      cursor,
    });

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          OR: [
            { createdAt: { lt: CREATED_AT } },
            { createdAt: CREATED_AT, id: { lt: cursor.id } },
          ],
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      }),
    );
    expect(result.orders.map((entry) => entry.orderId)).toEqual([
      "order_00000002",
    ]);
    expect(decodeCursor(result.nextCursor)).toEqual({
      createdAt: CREATED_AT.toISOString(),
      id: "order_00000002",
    });
  });
});
