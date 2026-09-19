import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { loadPublicTradeActivity } from "./public-trade-activity";

const createdAt = new Date("2026-09-19T12:00:00Z");
const market = { slug: "campus", shortTitle: "Campus outcome" };
const user = { username: "participant", profilePublic: true };
function trade(id: string, at = createdAt) {
  return { id, action: "BUY", side: "YES", quantity: 2, amountMilli: 81_001n,
    feeMilli: 811n, createdAt: at, market, user };
}
function fill(id: string, at = createdAt) {
  return { id, canonicalYesPriceMilli: 30_001n, quantity: 3, takerFeeMilli: 2_100n,
    createdAt: at, market: { ...market, payoutMilli: 100_001n },
    takerOrder: { action: "BUY", outcome: "NO", user } };
}
function database(trades: ReturnType<typeof trade>[] = [], fills: ReturnType<typeof fill>[] = []) {
  const tx = { trade: { findMany: vi.fn().mockResolvedValue(trades) },
    orderFill: { findMany: vi.fn().mockResolvedValue(fills) } };
  return { tx, client: tx as unknown as Prisma.TransactionClient };
}

describe("unified public trade activity", () => {
  it("uses exactly two bounded public-market queries with stable per-source ordering", async () => {
    const { tx, client } = database();
    expect(await loadPublicTradeActivity(client, 3)).toEqual([]);
    for (const delegate of [tx.trade, tx.orderFill]) {
      expect(delegate.findMany).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        where: { market: { status: { not: "DRAFT" } } }, take: 3,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }));
    }
    const select = tx.orderFill.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("makerOrder");
    expect(select.takerOrder.select.user.select).toEqual({ username: true, profilePublic: true });
  });

  it("merges timestamps and source-prefixed ID ties before applying the global limit", async () => {
    const { client } = database(
      [trade("new", new Date(createdAt.getTime() + 1)), trade("same"), trade("a")],
      [fill("z"), fill("same"), fill("old", new Date(createdAt.getTime() - 1))],
    );
    const items = await loadPublicTradeActivity(client, 4);
    expect(items.map((item) => item.id)).toEqual(["lmsr:new", "orderbook:z", "orderbook:same", "lmsr:same"]);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it.each(["BUY", "SELL"])("uses the NO taker's %s perspective once per fill and keeps fees separate", async (action) => {
    const row = fill("no");
    row.takerOrder.action = action;
    const { client } = database([], [row]);
    expect(await loadPublicTradeActivity(client)).toEqual([{
      id: "orderbook:no", source: "ORDER_BOOK", action, side: "NO", quantity: 3,
      amountMilli: 210_000n, feeMilli: 2_100n, createdAt, market, user,
    }]);
  });

  it("uses canonical YES execution price rather than the order limit", async () => {
    const row = fill("yes");
    row.takerOrder.outcome = "YES";
    const { client } = database([], [row]);
    expect(await loadPublicTradeActivity(client)).toMatchObject([{
      side: "YES", amountMilli: 90_003n, feeMilli: 2_100n,
    }]);
  });

  it("preserves legacy execution volume and exact bigints", async () => {
    const row = trade("legacy");
    row.amountMilli = 9_007_199_254_740_993n;
    const { client } = database([row]);
    expect(await loadPublicTradeActivity(client)).toEqual([{
      ...row, id: "lmsr:legacy", source: "LMSR",
    }]);
  });

  it("removes private usernames from both sources before returning public data", async () => {
    const legacy = trade("legacy");
    legacy.user = { username: "private-legacy", profilePublic: false };
    const execution = fill("book");
    execution.takerOrder.user = { username: "private-taker", profilePublic: false };
    const { client } = database([legacy], [execution]);
    const items = await loadPublicTradeActivity(client);
    expect(items.map((item) => item.user)).toEqual([
      { username: null, profilePublic: false }, { username: null, profilePublic: false },
    ]);
    expect(JSON.stringify(items, (_, value) => typeof value === "bigint" ? String(value) : value)).not.toContain("private-");
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity])("rejects invalid limit %s before reading", async (limit) => {
    const { tx, client } = database();
    await expect(loadPublicTradeActivity(client, limit)).rejects.toThrow(RangeError);
    expect(tx.trade.findMany).not.toHaveBeenCalled();
    expect(tx.orderFill.findMany).not.toHaveBeenCalled();
  });

  it("propagates a failed source rather than returning an incomplete live feed", async () => {
    const { tx, client } = database([trade("legacy")]);
    tx.orderFill.findMany.mockRejectedValue(new Error("read failed"));
    await expect(loadPublicTradeActivity(client)).rejects.toThrow("read failed");
  });
});
