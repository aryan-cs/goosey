import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadTradingActivity } from "./trading-activity";

const database = {
  trade: { groupBy: vi.fn() },
  marketOrder: { findMany: vi.fn() },
};

describe("trading activity aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.trade.groupBy.mockResolvedValue([]);
    database.marketOrder.findMany.mockResolvedValue([]);
  });

  it("counts both maker and taker executions", async () => {
    database.marketOrder.findMany.mockResolvedValue([
      { userId: "alice", marketId: "order-book", _count: { makerFills: 2, takerFills: 0 } },
      { userId: "alice", marketId: "order-book", _count: { makerFills: 0, takerFills: 3 } },
    ]);

    const activity = await loadTradingActivity(database as unknown as Prisma.TransactionClient, ["alice"]);

    expect(activity.get("alice")).toEqual({ trades: 5, marketsTraded: 1 });
  });

  it("counts every fill of a partially filled order but its market only once", async () => {
    database.marketOrder.findMany.mockResolvedValue([
      { userId: "alice", marketId: "partial-market", _count: { makerFills: 2, takerFills: 1 } },
    ]);

    const activity = await loadTradingActivity(database as unknown as Prisma.TransactionClient, ["alice"]);

    expect(activity.get("alice")).toEqual({ trades: 3, marketsTraded: 1 });
    expect(database.marketOrder.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ["alice"] }, filledQuantity: { gt: 0 } },
      select: {
        userId: true,
        marketId: true,
        _count: { select: { makerFills: true, takerFills: true } },
      },
    });
  });

  it("sums legacy and order-book executions while unioning overlapping markets", async () => {
    database.trade.groupBy.mockResolvedValue([
      { userId: "alice", marketId: "shared-market", _count: { _all: 2 } },
      { userId: "alice", marketId: "legacy-only", _count: { _all: 1 } },
    ]);
    database.marketOrder.findMany.mockResolvedValue([
      { userId: "alice", marketId: "shared-market", _count: { makerFills: 1, takerFills: 2 } },
      { userId: "alice", marketId: "book-only", _count: { makerFills: 0, takerFills: 1 } },
    ]);

    const activity = await loadTradingActivity(database as unknown as Prisma.TransactionClient, ["alice"]);

    expect(activity.get("alice")).toEqual({ trades: 7, marketsTraded: 3 });
  });

  it("deduplicates scoped user IDs and keeps each user's counts isolated", async () => {
    database.trade.groupBy.mockResolvedValue([
      { userId: "alice", marketId: "legacy-a", _count: { _all: 2 } },
      { userId: "bob", marketId: "legacy-b", _count: { _all: 1 } },
      { userId: "alice", marketId: "legacy-no-fill", _count: { _all: 0 } },
    ]);
    database.marketOrder.findMany.mockResolvedValue([
      { userId: "alice", marketId: "book-a", _count: { makerFills: 1, takerFills: 0 } },
      { userId: "bob", marketId: "book-b", _count: { makerFills: 0, takerFills: 4 } },
      // Defensive: a malformed/no-fill row must not add its market.
      { userId: "bob", marketId: "no-fill", _count: { makerFills: 0, takerFills: 0 } },
    ]);

    const activity = await loadTradingActivity(database as unknown as Prisma.TransactionClient, ["alice", "bob", "alice"]);

    expect(database.trade.groupBy).toHaveBeenCalledWith({
      by: ["userId", "marketId"],
      where: { userId: { in: ["alice", "bob"] } },
      _count: { _all: true },
    });
    expect(database.marketOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: { in: ["alice", "bob"] }, filledQuantity: { gt: 0 } },
    }));
    expect([...activity.entries()]).toEqual([
      ["alice", { trades: 3, marketsTraded: 2 }],
      ["bob", { trades: 5, marketsTraded: 2 }],
    ]);
  });

  it("returns an empty map without querying for an empty user list", async () => {
    const activity = await loadTradingActivity(database as unknown as Prisma.TransactionClient, []);

    expect(activity.size).toBe(0);
    expect(database.trade.groupBy).not.toHaveBeenCalled();
    expect(database.marketOrder.findMany).not.toHaveBeenCalled();
  });
});
