import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const findMarket = vi.fn();
  const groupBy = vi.fn();
  return {
    findMarket,
    groupBy,
    transaction: vi.fn(),
    tx: {
      market: { findUnique: findMarket },
      marketOrder: { groupBy },
    },
  };
});

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
  prisma: {
    $transaction: (...args: unknown[]) => {
      mocks.transaction(...args);
      const operation = args[0] as (tx: typeof mocks.tx) => unknown;
      return operation(mocks.tx);
    },
  },
}));

import { getPublicOrderBook } from "./order-service";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const FUTURE = new Date("2026-09-20T12:00:00.000Z");

function market(overrides: Record<string, unknown> = {}) {
  return {
    id: "market_depth",
    slug: "venue-wifi",
    status: "OPEN",
    pricingModel: "ORDER_BOOK",
    payoutMilli: 100_000n,
    bookSequence: 42n,
    acceptingOrders: true,
    closesAt: FUTURE,
    ...overrides,
  };
}

describe("public order-book depth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mocks.findMarket.mockResolvedValue(market());
    mocks.groupBy.mockImplementation(async ({ where }: { where: { bookSide: string } }) =>
      where.bookSide === "BUY"
        ? [
            { limitPriceMilli: 60_000n, _sum: { remainingQuantity: 3 }, _count: { _all: 2 } },
            { limitPriceMilli: 50_000n, _sum: { remainingQuantity: 1 }, _count: { _all: 1 } },
          ]
        : [{ limitPriceMilli: 70_000n, _sum: { remainingQuantity: 2 }, _count: { _all: 1 } }],
    );
  });

  afterEach(() => vi.useRealTimers());

  it("scopes, orders, and limits both sides using one expiry snapshot", async () => {
    const result = await getPublicOrderBook("venue-wifi", 2);

    expect(mocks.findMarket).toHaveBeenCalledWith({
      where: { slug: "venue-wifi" },
      select: {
        id: true,
        slug: true,
        status: true,
        pricingModel: true,
        payoutMilli: true,
        bookSequence: true,
        acceptingOrders: true,
        closesAt: true,
      },
    });
    const active = {
      marketId: "market_depth",
      user: { status: "ACTIVE", role: "USER" },
      status: { in: ["OPEN", "PARTIALLY_FILLED"] },
      remainingQuantity: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
    };
    expect(mocks.groupBy).toHaveBeenNthCalledWith(1, {
      by: ["limitPriceMilli"],
      where: { ...active, bookSide: "BUY" },
      _sum: { remainingQuantity: true },
      _count: { _all: true },
      orderBy: { limitPriceMilli: "desc" },
      take: 2,
    });
    expect(mocks.groupBy).toHaveBeenNthCalledWith(2, {
      by: ["limitPriceMilli"],
      where: { ...active, bookSide: "SELL" },
      _sum: { remainingQuantity: true },
      _count: { _all: true },
      orderBy: { limitPriceMilli: "asc" },
      take: 2,
    });
    const bidNow = mocks.groupBy.mock.calls[0]![0].where.OR[1].expiresAt.gt;
    const askNow = mocks.groupBy.mock.calls[1]![0].where.OR[1].expiresAt.gt;
    expect(bidNow).toBe(askNow);
    expect(bidNow).toEqual(NOW);
    expect(result).toEqual({
      marketSlug: "venue-wifi",
      marketStatus: "OPEN",
      sequence: 42n,
      payoutMilli: 100_000n,
      bids: [
        { priceMilli: 60_000n, quantity: 3n, orderCount: 2 },
        { priceMilli: 50_000n, quantity: 1n, orderCount: 1 },
      ],
      asks: [{ priceMilli: 70_000n, quantity: 2n, orderCount: 1 }],
    });
  });

  it.each([
    ["closed", { status: "CLOSED" }],
    ["paused", { status: "PAUSED" }],
    ["disabled", { acceptingOrders: false }],
    ["past-close", { closesAt: NOW }],
  ])("returns metadata with empty depth for a %s market without grouping", async (_label, state) => {
    mocks.findMarket.mockResolvedValue(market(state));

    const result = await getPublicOrderBook("venue-wifi", 25);

    expect(result).toMatchObject({
      marketSlug: "venue-wifi",
      marketStatus: "status" in state ? state.status : "OPEN",
      sequence: 42n,
      payoutMilli: 100_000n,
      bids: [],
      asks: [],
    });
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("keeps draft markets hidden", async () => {
    mocks.findMarket.mockResolvedValue(market({ status: "DRAFT" }));

    await expect(getPublicOrderBook("venue-wifi", 10)).rejects.toMatchObject({
      status: 404,
      code: "MARKET_NOT_FOUND",
    });
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });

  it("keeps legacy market-maker books unavailable", async () => {
    mocks.findMarket.mockResolvedValue(market({ pricingModel: "LMSR" }));

    await expect(getPublicOrderBook("venue-wifi", 10)).rejects.toMatchObject({
      status: 422,
      code: "ORDER_BOOK_UNAVAILABLE",
    });
    expect(mocks.groupBy).not.toHaveBeenCalled();
  });
});
