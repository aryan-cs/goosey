import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodeTradeHistoryCursor,
  loadTradeHistory,
  parseTradeHistoryCursor,
} from "./trade-history";

const tx = {
  trade: { findMany: vi.fn() },
  orderFill: { findMany: vi.fn() },
};

const T0 = new Date("2026-09-19T12:00:00.000Z");
const T1 = new Date("2026-09-19T12:01:00.000Z");

function legacy(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    side: "YES",
    action: "BUY",
    quantity: 2,
    amountMilli: 80_000n,
    feeMilli: 800n,
    createdAt: T0,
    market: { slug: "legacy-market", shortTitle: "Legacy market" },
    ...overrides,
  };
}

function fill(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    canonicalYesPriceMilli: 40_000n,
    quantity: 2,
    makerFeeMilli: 7n,
    takerFeeMilli: 11n,
    createdAt: T0,
    market: { slug: "book-market", shortTitle: "Book market", payoutMilli: 100_000n },
    makerOrder: { userId: "user", outcome: "NO", action: "BUY" },
    takerOrder: { userId: "peer", outcome: "YES", action: "SELL" },
    ...overrides,
  };
}

describe("unified private trade history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.trade.findMany.mockResolvedValue([]);
    tx.orderFill.findMany.mockResolvedValue([]);
  });

  it("scopes both sources to the owner and exposes no peer order identity", async () => {
    tx.trade.findMany.mockResolvedValue([legacy("trade_a")]);
    tx.orderFill.findMany.mockResolvedValue([fill("fill_a")]);

    const page = await loadTradeHistory(tx as never, "user", { limit: 10 });

    expect(tx.trade.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user" },
      take: 11,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
    expect(tx.orderFill.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ makerOrder: { userId: "user" } }, { takerOrder: { userId: "user" } }] },
      take: 11,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
    expect(page.items.map((item) => item.id)).toEqual(["orderbook:fill_a", "lmsr:trade_a"]);
    expect(page.items[0]).not.toHaveProperty("makerOrder");
    expect(page.items[0]).not.toHaveProperty("takerOrder");
    expect(page.items[0]).not.toHaveProperty("orderId");
  });

  it("uses the maker's own NO complement and maker fee", async () => {
    tx.orderFill.findMany.mockResolvedValue([fill("fill_no_maker")]);

    const page = await loadTradeHistory(tx as never, "user", { limit: 10 });

    expect(page.items[0]).toEqual({
      id: "orderbook:fill_no_maker",
      market: { slug: "book-market", shortTitle: "Book market" },
      side: "NO",
      action: "BUY",
      quantity: 2,
      amountMilli: 120_000n,
      feeMilli: 7n,
      createdAt: T0,
      source: "ORDER_BOOK",
    });
  });

  it("uses the taker's own outcome, action, gross, and taker fee", async () => {
    tx.orderFill.findMany.mockResolvedValue([fill("fill_yes_taker", {
      quantity: 3,
      makerOrder: { userId: "peer", outcome: "NO", action: "BUY" },
      takerOrder: { userId: "user", outcome: "YES", action: "SELL" },
    })]);

    const page = await loadTradeHistory(tx as never, "user", { limit: 10 });

    expect(page.items[0]).toMatchObject({
      side: "YES",
      action: "SELL",
      quantity: 3,
      amountMilli: 120_000n,
      feeMilli: 11n,
      source: "ORDER_BOOK",
    });
  });

  it("merges sources by timestamp and then prefixed id descending", async () => {
    tx.trade.findMany.mockResolvedValue([
      legacy("z", { createdAt: T0 }),
      legacy("a", { createdAt: T0 }),
    ]);
    tx.orderFill.findMany.mockResolvedValue([
      fill("a", { createdAt: T1 }),
      fill("z", { createdAt: T0 }),
    ]);

    const page = await loadTradeHistory(tx as never, "user", { limit: 10 });

    expect(page.items.map((item) => item.id)).toEqual([
      "orderbook:a",
      "orderbook:z",
      "lmsr:z",
      "lmsr:a",
    ]);
  });

  it("paginates equal timestamps without duplicates or dropped source rows", async () => {
    tx.trade.findMany
      .mockResolvedValueOnce([legacy("z"), legacy("a")])
      .mockResolvedValueOnce([legacy("a")]);
    tx.orderFill.findMany
      .mockResolvedValueOnce([fill("z"), fill("a")])
      .mockResolvedValueOnce([]);

    const first = await loadTradeHistory(tx as never, "user", { limit: 3 });
    const cursor = parseTradeHistoryCursor(first.nextCursor!);
    const second = await loadTradeHistory(tx as never, "user", { limit: 3, cursor });

    expect(first.items.map((item) => item.id)).toEqual(["orderbook:z", "orderbook:a", "lmsr:z"]);
    expect(second.items.map((item) => item.id)).toEqual(["lmsr:a"]);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
    expect(second.nextCursor).toBeNull();
    expect(tx.trade.findMany.mock.calls[1]![0].where).toEqual({
      userId: "user",
      AND: [{ OR: [
        { createdAt: { lt: T0 } },
        { createdAt: T0, id: { lt: "z" } },
      ] }],
    });
    // ORDER_BOOK sorts above LMSR at equal timestamps, so after an LMSR
    // cursor it must not re-query any equal-time order-book ids.
    expect(tx.orderFill.findMany.mock.calls[1]![0].where).toEqual({
      OR: [{ makerOrder: { userId: "user" } }, { takerOrder: { userId: "user" } }],
      AND: [{ OR: [{ createdAt: { lt: T0 } }] }],
    });
  });

  it("includes every lower-prefix row at an equal-time ORDER_BOOK cutoff", async () => {
    const cursor = { createdAt: T0, id: "orderbook:a" };
    await loadTradeHistory(tx as never, "user", { limit: 2, cursor });

    expect(tx.trade.findMany.mock.calls[0]![0].where).toEqual({
      userId: "user",
      AND: [{ OR: [
        { createdAt: { lt: T0 } },
        { createdAt: T0 },
      ] }],
    });
    expect(tx.orderFill.findMany.mock.calls[0]![0].where).toEqual({
      OR: [{ makerOrder: { userId: "user" } }, { takerOrder: { userId: "user" } }],
      AND: [{ OR: [
        { createdAt: { lt: T0 } },
        { createdAt: T0, id: { lt: "a" } },
      ] }],
    });
  });
});

describe("trade history cursor", () => {
  it("round-trips a strict opaque cursor", () => {
    const encoded = encodeTradeHistoryCursor({ createdAt: T0, id: "orderbook:fill_123" });
    expect(parseTradeHistoryCursor(encoded)).toEqual({ createdAt: T0, id: "orderbook:fill_123" });
    expect(parseTradeHistoryCursor(undefined)).toBeUndefined();
  });

  it.each([
    "not-base64",
    Buffer.from(JSON.stringify({ createdAt: T0.toISOString(), id: "unknown:row" })).toString("base64url"),
    Buffer.from(JSON.stringify({ createdAt: "not-a-date", id: "lmsr:row" })).toString("base64url"),
    Buffer.from(JSON.stringify({ createdAt: T0.toISOString(), id: "lmsr:row", extra: "x" })).toString("base64url"),
    "x".repeat(513),
  ])("rejects malformed cursor %#", (raw) => {
    expect(() => parseTradeHistoryCursor(raw)).toThrow(expect.objectContaining({
      status: 400,
      code: "INVALID_CURSOR",
    }));
  });
});
