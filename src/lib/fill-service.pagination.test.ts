import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findMarket: vi.fn() }));

vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
      super(message);
    }
  },
  prisma: { orderFill: { findMany: mocks.findMany }, market: { findUnique: mocks.findMarket } },
}));

import { listPublicTrades, listUserFills } from "./fill-service";
import { decodeCursor } from "./serializers";

function fill(id: string, createdAt: string) {
  return {
    id,
    canonicalYesPriceMilli: 55_000n,
    quantity: 2,
    makerFeeMilli: 4n,
    takerFeeMilli: 6n,
    matchType: "CROSS",
    tradeSequence: 1n,
    createdAt: new Date(createdAt),
    market: { slug: "fixture", title: "Fixture", payoutMilli: 100_000n },
    makerOrder: { id: `maker_${id}`, userId: "user_12345678", clientOrderId: `maker-client-${id}`, outcome: "YES", action: "BUY" },
    takerOrder: { id: `taker_${id}`, userId: "other_12345678", clientOrderId: `taker-client-${id}`, outcome: "YES", action: "SELL" },
  };
}

describe("private fill history pagination", () => {
  beforeEach(() => mocks.findMany.mockReset());

  it("uses one lookahead row and returns a cursor for the last visible fill", async () => {
    mocks.findMany.mockResolvedValue([
      fill("fill_00000003", "2026-09-19T12:03:00.000Z"),
      fill("fill_00000002", "2026-09-19T12:02:00.000Z"),
      fill("fill_00000001", "2026-09-19T12:01:00.000Z"),
    ]);

    const result = await listUserFills({ userId: "user_12345678", role: "MAKER", limit: 2 });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ makerOrder: { userId: "user_12345678" } }),
      take: 3,
    }));
    expect(result.fills.map((entry) => entry.fillId)).toEqual(["fill_00000003", "fill_00000002"]);
    expect(decodeCursor(result.nextCursor)).toEqual({
      createdAt: "2026-09-19T12:02:00.000Z",
      id: "fill_00000002",
    });
  });

  it("applies a descending createdAt/id keyset without replacing the ownership predicate", async () => {
    mocks.findMany.mockResolvedValue([fill("fill_00000001", "2026-09-19T12:01:00.000Z")]);
    const cursor = { createdAt: new Date("2026-09-19T12:02:00.000Z"), id: "fill_00000002" };

    const result = await listUserFills({ userId: "user_12345678", limit: 2, cursor });

    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        market: { executionBackend: "DATABASE", collateralAccountId: { not: null } },
        OR: [
          { makerOrder: { userId: "user_12345678" } },
          { takerOrder: { userId: "user_12345678" } },
        ],
        AND: [{ OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ] }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    }));
    expect(result.nextCursor).toBeNull();
  });
});

describe("public tape watermark", () => {
  it("excludes fills committed after the captured sequence and keeps the pagination boundary", async () => {
    mocks.findMarket.mockResolvedValue({
      executionBackend: "DATABASE", collateralAccountId: "collateral", id: "market_fixture", slug: "fixture", status: "OPEN",
      pricingModel: "ORDER_BOOK", payoutMilli: 100_000n, tradeSequence: 10n,
    });
    mocks.findMany.mockImplementation(async ({ where }) => {
      // Sequence 11 became visible after the market read. It belongs to the
      // next refresh, not a response advertising sequence 10.
      return [11n, 10n, 9n].filter((sequence) =>
        sequence <= where.tradeSequence.lte && sequence < where.tradeSequence.lt,
      ).map((tradeSequence) => ({
        tradeSequence, canonicalYesPriceMilli: 55_000n, quantity: 2,
        matchType: "TRANSFER", createdAt: new Date("2026-09-19T12:00:00Z"),
        takerOrder: { bookSide: "BUY" },
      }));
    });
    const result = await listPublicTrades({
      marketSlug: "fixture", limit: 1,
      cursor: { marketSlug: "fixture", tradeSequence: 12n },
    });
    expect(result.sequence).toBe(10n);
    expect(result.trades.map((trade) => trade.tradeSequence)).toEqual([10n]);
    expect(decodeCursor(result.nextCursor)).toEqual({ marketSlug: "fixture", tradeSequence: "10" });
  });
});
