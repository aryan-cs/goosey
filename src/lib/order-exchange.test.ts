import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  runner: undefined as undefined | ((...args: unknown[]) => unknown),
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
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: (...args: unknown[]) => {
        mocks.transaction(...args);
        if (!mocks.runner) throw new TypeError("transaction runner missing");
        return mocks.runner(...args);
      },
    },
  };
});

import {
  appendAuthoritativeFillSnapshot,
  cancelOrder,
  cancelOrderRequestSchema,
  expireOrders,
  placeOrder,
  placeOrderRequestSchema,
  replaceOrder,
  replaceOrderRequestSchema,
} from "./order-exchange";

const USER_ID = "user_12345678";
const MARKET_ID = "market_12345678";
const ORDER_ID = "order_12345678";
const KEY = "idempotency-key-123456";

function runTransactionWith<T>(tx: T) {
  mocks.runner = async (...args: unknown[]) => {
    const callback = args.find((value): value is (value: T) => unknown => typeof value === "function");
    if (!callback) throw new TypeError(`transaction callback missing: ${args.map((value) => typeof value).join(",")}`);
    return callback(tx);
  };
}

function activeUser() {
  return {
    id: USER_ID,
    role: "USER",
    status: "ACTIVE",
    balanceMilli: 1_000_000n,
    realizedPnlMilli: 0n,
  };
}

function orderBookMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: MARKET_ID,
    slug: "test-market",
    status: "OPEN",
    pricingModel: "ORDER_BOOK",
    acceptingOrders: true,
    closesAt: new Date(Date.now() + 60_000),
    payoutMilli: 100_000n,
    feeBps: 100,
    commandSequence: 4n,
    bookSequence: 9n,
    tradeSequence: 2n,
    collateralAccountId: "collateral_12345678",
    collateralAccount: { id: "collateral_12345678", balanceMilli: 0n },
    ...overrides,
  };
}

describe("order exchange request contracts", () => {
  it("accepts canonical order input and rejects unknown, noncanonical, and unsafe fields", () => {
    const parsed = placeOrderRequestSchema.parse({
      marketId: MARKET_ID,
      clientOrderId: "client-order-123456",
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "42000",
      quantity: 3,
    });
    expect(parsed.limitPriceMilli).toBe(42_000n);
    expect(parsed.timeInForce).toBe("GTC");
    expect(() => placeOrderRequestSchema.parse({
      marketId: MARKET_ID,
      clientOrderId: "client-order-123456",
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "042000",
      quantity: 3,
    })).toThrow();
    expect(() => placeOrderRequestSchema.parse({
      marketId: MARKET_ID,
      clientOrderId: "client-order-123456",
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "42000",
      quantity: 3,
      userId: "attacker",
    })).toThrow();
    expect(() => placeOrderRequestSchema.parse({
      marketId: MARKET_ID,
      clientOrderId: "client-order-123456",
      outcome: "YES",
      action: "BUY",
      limitPriceMilli: "42000",
      quantity: 3,
      timeInForce: "IOC",
      postOnly: true,
    })).toThrow();
    expect(cancelOrderRequestSchema.parse({ orderId: ORDER_ID })).toEqual({ orderId: ORDER_ID });
    expect(replaceOrderRequestSchema.parse({
      orderId: ORDER_ID,
      expectedVersion: 4,
      clientOrderId: "replacement-client-1234",
      limitPriceMilli: "43000",
      quantity: 7,
    })).toMatchObject({
      orderId: ORDER_ID,
      expectedVersion: 4,
      limitPriceMilli: 43_000n,
      quantity: 7,
    });
    expect(() => replaceOrderRequestSchema.parse({
      orderId: ORDER_ID,
      clientOrderId: "replacement-client-1234",
      limitPriceMilli: "43000",
      quantity: 7,
    })).toThrow();
  });
});

describe("transactional replacement authorization", () => {
  beforeEach(() => mocks.transaction.mockReset());

  it("uses an owner-scoped lookup and does not disclose a foreign order", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
      marketOrder: { findFirst },
    };
    runTransactionWith(tx);

    await expect(replaceOrder({
      userId: USER_ID,
      idempotencyKey: KEY,
      request: {
        orderId: ORDER_ID,
        expectedVersion: 0,
        clientOrderId: "replacement-client-1234",
        limitPriceMilli: "43000",
        quantity: 7,
      },
    })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ORDER_ID, userId: USER_ID },
    }));
  });

  it("rejects a stale replacement before sequencing or releasing backing", async () => {
    const tx = {
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
      marketOrder: {
        findFirst: vi.fn().mockResolvedValue({
          id: ORDER_ID,
          userId: USER_ID,
          marketId: MARKET_ID,
          status: "OPEN",
          remainingQuantity: 3,
          timeInForce: "GTC",
          version: 5,
          reservation: { orderId: ORDER_ID },
        }),
      },
      market: { updateMany: vi.fn() },
    };
    runTransactionWith(tx);

    await expect(replaceOrder({
      userId: USER_ID,
      idempotencyKey: KEY,
      request: {
        orderId: ORDER_ID,
        expectedVersion: 4,
        clientOrderId: "replacement-client-1234",
        limitPriceMilli: "43000",
        quantity: 7,
      },
    })).rejects.toMatchObject({
      code: "STALE_ORDER_VERSION",
      status: 409,
      details: { currentVersion: 5 },
    });
    expect(tx.market.updateMany).not.toHaveBeenCalled();
  });
});

describe("authoritative CLOB history", () => {
  it("writes exactly one honest final-fill mark and no intermediate sweep points", async () => {
    const create = vi.fn().mockResolvedValue({ id: "snapshot_12345678" });
    const tx = { marketPriceSnapshot: { create } };
    const recordedAt = new Date("2026-09-19T12:00:00.000Z");

    await appendAuthoritativeFillSnapshot(tx as never, MARKET_ID, 100_000n, [
      { priceMilli: 41_000n },
      { priceMilli: 42_000n },
      { priceMilli: 43_000n },
    ], recordedAt);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { marketId: MARKET_ID, yesProbabilityBps: 4_300, createdAt: recordedAt },
    });
  });

  it("does not fabricate a history point when no contract executed", async () => {
    const create = vi.fn();
    await expect(
      appendAuthoritativeFillSnapshot(
        { marketPriceSnapshot: { create } } as never,
        MARKET_ID,
        100_000n,
        [],
      ),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("transactional placement", () => {
  beforeEach(() => mocks.transaction.mockReset());

  it("preserves LMSR markets by rejecting before sequence, order, or ledger mutation", async () => {
    const tx = {
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
      user: { findUnique: vi.fn().mockResolvedValue(activeUser()) },
      market: {
        findUnique: vi.fn().mockResolvedValue(orderBookMarket({ pricingModel: "LMSR" })),
        updateMany: vi.fn(),
      },
    };
    runTransactionWith(tx);

    await expect(placeOrder({
      userId: USER_ID,
      idempotencyKey: KEY,
      request: {
        marketId: MARKET_ID,
        clientOrderId: "client-order-123456",
        outcome: "YES",
        action: "BUY",
        limitPriceMilli: "40000",
        quantity: 2,
      },
    })).rejects.toMatchObject({ code: "ORDER_BOOK_UNAVAILABLE", status: 422 });
    expect(tx.market.updateMany).not.toHaveBeenCalled();
  });

  it("permanently records and replays a deterministic post-only rejection", async () => {
    let storedCommand: Record<string, unknown> | null = null;
    const tx = {
      orderCommand: {
        findUnique: vi.fn().mockImplementation(async () => storedCommand),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          storedCommand = data;
          return data;
        }),
      },
      user: { findUnique: vi.fn().mockResolvedValue(activeUser()) },
      market: {
        findUnique: vi.fn().mockResolvedValue(orderBookMarket()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      marketOrder: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([{
          id: "maker_12345678",
          userId: "maker_user_1234",
          stpOwnerId: "maker_user_1234",
          bookSide: "SELL",
          limitPriceMilli: 40_000n,
          remainingQuantity: 2,
          prioritySequence: 1n,
          reservation: null,
        }]),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    runTransactionWith(tx);
    const input = {
      userId: USER_ID,
      idempotencyKey: KEY,
      request: {
        marketId: MARKET_ID,
        clientOrderId: "client-order-123456",
        outcome: "YES",
        action: "BUY",
        limitPriceMilli: "45000",
        quantity: 2,
        postOnly: true,
      },
    };

    const first = await placeOrder(input);
    const second = await placeOrder(input);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accepted: false, reason: "POST_ONLY_WOULD_TRADE", commandSequence: "5" });
    expect(tx.orderCommand.create).toHaveBeenCalledTimes(1);
    expect(tx.market.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ type: "ORDER_REJECTED", visibility: "PRIVATE" }),
    }));
  });

  it("normalizes a NO bid, reserves exact cash and fee, and rests it atomically", async () => {
    const user = activeUser();
    const market = orderBookMarket();
    const calls: { order?: Record<string, unknown>; reservation?: Record<string, unknown>; journal?: Record<string, unknown> } = {};
    const now = new Date();
    const tx = {
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
      user: {
        findUnique: vi.fn().mockResolvedValue(user),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      market: {
        findUnique: vi.fn().mockResolvedValue(market),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      marketOrder: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          calls.order = data;
          return {
            ...data,
            filledQuantity: 0,
            canceledQuantity: 0,
            reservedCashMilli: 0n,
            reservedFeeMilli: 0n,
            reservedShares: 0,
            cumulativeFeeMilli: 0n,
            terminalSequence: null,
            version: 0,
            replacementVersion: 0,
            replacedOrderId: null,
            reduceOnly: false,
            terminalReason: null,
            terminalAt: null,
            canceledAt: null,
            createdAt: now,
            updatedAt: now,
            reservation: null,
          };
        }),
      },
      ledgerAccount: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet_12345678", balanceMilli: user.balanceMilli }),
        create: vi.fn().mockResolvedValue({ id: "reserve_12345678", balanceMilli: 0n }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      journalEntry: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          calls.journal = data;
          return { id: "journal_12345678", ...data };
        }),
      },
      orderReservation: {
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          calls.reservation = data;
          return { ...data, version: 0, releaseJournalId: null, reservedYesQuantity: 0, reservedNoQuantity: 0, createdAt: now, updatedAt: now };
        }),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    runTransactionWith(tx);

    const result = await placeOrder({
      userId: USER_ID,
      idempotencyKey: KEY,
      request: {
        marketId: MARKET_ID,
        clientOrderId: "client-order-123456",
        outcome: "NO",
        action: "BUY",
        limitPriceMilli: "60000",
        quantity: 2,
      },
    });

    expect(result).toMatchObject({ accepted: true, order: { bookSide: "SELL", limitPriceMilli: "40000", remainingQuantity: 2 } });
    expect(calls.order).toMatchObject({ bookSide: "SELL", limitPriceMilli: 40_000n });
    expect(calls.reservation).toMatchObject({
      reservedPrincipalMilli: 120_000n,
      reservedFeeMilli: 1_200n,
      cashAccountId: "reserve_12345678",
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { balanceMilli: { decrement: 121_200n } },
    }));
    expect(calls.journal).toMatchObject({
      type: "ORDER_RESERVE",
      postings: {
        create: [
          { ledgerAccountId: "wallet_12345678", amountMilli: -121_200n },
          { ledgerAccountId: "reserve_12345678", amountMilli: 121_200n },
        ],
      },
    });
  });
});

describe("transactional cancellation", () => {
  beforeEach(() => mocks.transaction.mockReset());

  it("uses an owner-scoped lookup and returns indistinguishable not-found for a foreign ID", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = {
      orderCommand: { findUnique: vi.fn().mockResolvedValue(null) },
      marketOrder: { findFirst },
    };
    runTransactionWith(tx);

    await expect(cancelOrder({
      userId: USER_ID,
      idempotencyKey: KEY,
      request: { orderId: ORDER_ID },
    })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", status: 404 });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ORDER_ID, userId: USER_ID },
    }));
  });

  it("releases only the live cash reservation and permanently replays the cancellation", async () => {
    const now = new Date();
    const user = activeUser();
    const market = orderBookMarket({ status: "PAUSED", acceptingOrders: false });
    const reservation = {
      orderId: ORDER_ID,
      userId: USER_ID,
      marketId: MARKET_ID,
      cashAccountId: "reserve_12345678",
      reserveJournalId: "reserve-journal-1",
      releaseJournalId: null,
      reservedPrincipalMilli: 39_000n,
      reservedFeeMilli: 1_000n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
      version: 2,
      createdAt: now,
      updatedAt: now,
    };
    const baseOrder = {
      id: ORDER_ID,
      userId: USER_ID,
      marketId: MARKET_ID,
      clientOrderId: "client-order-123456",
      outcome: "YES",
      action: "BUY",
      bookSide: "BUY",
      limitPriceMilli: 40_000n,
      originalQuantity: 2,
      remainingQuantity: 1,
      filledQuantity: 1,
      canceledQuantity: 0,
      status: "PARTIALLY_FILLED",
      timeInForce: "GTC",
      postOnly: false,
      stpOwnerId: USER_ID,
      selfTradePrevention: "CANCEL_AGGRESSOR",
      reservedCashMilli: 0n,
      reservedFeeMilli: 0n,
      reservedShares: 0,
      cumulativeFeeMilli: 400n,
      acceptedSequence: 3n,
      prioritySequence: 3n,
      terminalSequence: null,
      version: 4,
      orderChainId: ORDER_ID,
      replacementVersion: 0,
      replacedOrderId: null,
      expiresAt: null,
      cancelOnPause: true,
      reduceOnly: false,
      terminalReason: null,
      terminalAt: null,
      canceledAt: null,
      createdAt: now,
      updatedAt: now,
      reservation,
      market,
      user,
    };
    let storedCommand: Record<string, unknown> | null = null;
    let releaseData: Record<string, unknown> | undefined;
    const tx = {
      orderCommand: {
        findUnique: vi.fn().mockImplementation(async () => storedCommand),
        create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          storedCommand = data;
          return data;
        }),
      },
      marketOrder: {
        findFirst: vi.fn().mockResolvedValue(baseOrder),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...baseOrder,
          remainingQuantity: 0,
          canceledQuantity: 1,
          status: "CANCELED",
          version: 5,
        }),
      },
      market: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(user),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ledgerAccount: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet_12345678", balanceMilli: user.balanceMilli }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      journalEntry: { create: vi.fn().mockResolvedValue({ id: "release-journal-1" }) },
      orderReservation: {
        update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
          releaseData = data;
          return { ...reservation, ...data };
        }),
      },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    runTransactionWith(tx);
    const input = { userId: USER_ID, idempotencyKey: KEY, request: { orderId: ORDER_ID, expectedVersion: 4 } };

    const first = await cancelOrder(input);
    const second = await cancelOrder(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ canceledQuantity: 1, commandSequence: "5", order: { status: "CANCELED" } });
    expect(tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { balanceMilli: { increment: 40_000n } },
    }));
    expect(tx.ledgerAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "reserve_12345678", balanceMilli: { gte: 40_000n } }),
      data: { balanceMilli: { decrement: 40_000n } },
    }));
    expect(releaseData).toMatchObject({
      reservedPrincipalMilli: 0n,
      reservedFeeMilli: 0n,
      releaseJournalId: "release-journal-1",
    });
    expect(tx.orderCommand.create).toHaveBeenCalledTimes(1);
    expect(tx.market.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ status: "OPEN" }),
    }));
  });
});

describe("sequenced order expiration", () => {
  it("atomically releases backing and records a terminal private event", async () => {
    const operationAt = new Date("2026-09-19T12:00:00.000Z");
    const reservation = {
      orderId: ORDER_ID,
      userId: USER_ID,
      marketId: MARKET_ID,
      cashAccountId: "reserve_12345678",
      reserveJournalId: "reserve-journal-1",
      releaseJournalId: null,
      reservedPrincipalMilli: 39_000n,
      reservedFeeMilli: 1_000n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
      version: 0,
      createdAt: operationAt,
      updatedAt: operationAt,
    };
    const order = {
      id: ORDER_ID,
      userId: USER_ID,
      marketId: MARKET_ID,
      outcome: "YES",
      action: "BUY",
      remainingQuantity: 1,
      status: "OPEN",
      version: 2,
      expiresAt: new Date("2026-09-19T11:59:59.000Z"),
      reservation,
      market: orderBookMarket(),
    };
    const tx = {
      marketOrder: {
        findUnique: vi.fn().mockResolvedValue(order),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      market: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(activeUser()),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ledgerAccount: {
        upsert: vi.fn().mockResolvedValue({ id: "wallet_12345678", balanceMilli: 1_000_000n }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      journalEntry: { create: vi.fn().mockResolvedValue({ id: "release-journal-1" }) },
      orderReservation: { update: vi.fn().mockResolvedValue({}) },
      orderEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const beforeEach = vi.fn().mockResolvedValue(undefined);
    const client = {
      marketOrder: { findMany: vi.fn().mockResolvedValue([{ id: ORDER_ID }]) },
      $transaction: vi.fn().mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    };

    await expect(expireOrders(client as never, operationAt, beforeEach)).resolves.toEqual({ expired: 1, failures: [] });
    expect(beforeEach).toHaveBeenCalledOnce();
    expect(tx.marketOrder.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "CANCELED",
        terminalReason: "ORDER_EXPIRED",
        canceledQuantity: { increment: 1 },
        remainingQuantity: 0,
      }),
    }));
    expect(tx.orderEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "ORDER_CANCELED",
        visibility: "PRIVATE",
        payload: expect.stringContaining("ORDER_EXPIRED"),
      }),
    }));
    expect(tx.user.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { balanceMilli: { increment: 40_000n } },
    }));
  });
});
