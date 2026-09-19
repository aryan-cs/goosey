import { describe, expect, it } from "vitest";

import {
  denormalizeYesPrice,
  matchOrder,
  normalizeToYesBook,
  sortBook,
  type IncomingOrder,
  type RestingOrder,
} from "./order-book";

const PAYOUT = 100_000n;

function resting(overrides: Partial<RestingOrder> & Pick<RestingOrder, "id">): RestingOrder {
  return {
    ownerId: `owner-${overrides.id}`,
    stpOwnerId: `owner-${overrides.id}`,
    side: "SELL",
    limitPriceMilli: 50_000n,
    remainingQuantity: 10,
    prioritySequence: 1n,
    ...overrides,
  };
}

function incoming(overrides: Partial<IncomingOrder> = {}): IncomingOrder {
  return {
    id: "taker",
    ownerId: "taker-owner",
    stpOwnerId: "taker-owner",
    side: "BUY",
    limitPriceMilli: 50_000n,
    remainingQuantity: 10,
    prioritySequence: 100n,
    timeInForce: "GTC",
    postOnly: false,
    selfTradePrevention: "CANCEL_AGGRESSOR",
    ...overrides,
  };
}

describe("binary order normalization", () => {
  it("maps YES and NO actions to one canonical YES book exactly", () => {
    expect(normalizeToYesBook("YES", "BUY", 42_000n, PAYOUT)).toEqual({
      side: "BUY",
      limitPriceMilli: 42_000n,
    });
    expect(normalizeToYesBook("YES", "SELL", 42_000n, PAYOUT)).toEqual({
      side: "SELL",
      limitPriceMilli: 42_000n,
    });
    expect(normalizeToYesBook("NO", "BUY", 58_000n, PAYOUT)).toEqual({
      side: "SELL",
      limitPriceMilli: 42_000n,
    });
    expect(normalizeToYesBook("NO", "SELL", 58_000n, PAYOUT)).toEqual({
      side: "BUY",
      limitPriceMilli: 42_000n,
    });
    expect(denormalizeYesPrice("NO", 42_000n, PAYOUT)).toBe(58_000n);
  });

  it("rejects endpoint and out-of-range prices", () => {
    expect(() => normalizeToYesBook("YES", "BUY", 0n, PAYOUT)).toThrow(RangeError);
    expect(() => normalizeToYesBook("YES", "BUY", PAYOUT, PAYOUT)).toThrow(RangeError);
  });

  it("round-trips every legal price exactly, including an odd payout", () => {
    const oddPayout = 101n;
    for (let price = 1n; price < oddPayout; price += 1n) {
      for (const outcome of ["YES", "NO"] as const) {
        for (const action of ["BUY", "SELL"] as const) {
          const normalized = normalizeToYesBook(outcome, action, price, oddPayout);
          expect(denormalizeYesPrice(outcome, normalized.limitPriceMilli, oddPayout)).toBe(price);
          expect(normalized.limitPriceMilli + (oddPayout - normalized.limitPriceMilli)).toBe(oddPayout);
        }
      }
    }
  });
});

describe("deterministic price-time matching", () => {
  it("sorts both sides by price-time priority with a locale-independent ID tie-break", () => {
    const book = [
      resting({ id: "a", side: "BUY", limitPriceMilli: 40_000n, prioritySequence: 2n }),
      resting({ id: "z", side: "SELL", limitPriceMilli: 60_000n, prioritySequence: 1n }),
      resting({ id: "a-sell", side: "SELL", limitPriceMilli: 55_000n, prioritySequence: 1n }),
      resting({ id: "a-low", side: "BUY", limitPriceMilli: 39_000n, prioritySequence: 1n }),
      resting({ id: "a-early", side: "BUY", limitPriceMilli: 40_000n, prioritySequence: 1n }),
      resting({ id: "B", side: "BUY", limitPriceMilli: 40_000n, prioritySequence: 2n }),
    ];

    expect(sortBook(book).map((order) => order.id)).toEqual([
      "a-early",
      "B",
      "a",
      "a-low",
      "a-sell",
      "z",
    ]);
  });

  it("fills best price first and FIFO within a price", () => {
    const book = [
      resting({ id: "late-best", limitPriceMilli: 41_000n, remainingQuantity: 2, prioritySequence: 3n }),
      resting({ id: "worse", limitPriceMilli: 42_000n, remainingQuantity: 4, prioritySequence: 1n }),
      resting({ id: "early-best", limitPriceMilli: 41_000n, remainingQuantity: 2, prioritySequence: 2n }),
    ];
    const result = matchOrder(book, incoming({ limitPriceMilli: 43_000n, remainingQuantity: 5 }), PAYOUT);

    expect(result.fills.map(({ makerOrderId, quantity, priceMilli }) => [makerOrderId, quantity, priceMilli])).toEqual([
      ["early-best", 2, 41_000n],
      ["late-best", 2, 41_000n],
      ["worse", 1, 42_000n],
    ]);
    expect(result.disposition).toBe("FILLED");
    expect(result.restingOrders).toEqual([
      expect.objectContaining({ id: "worse", remainingQuantity: 3 }),
    ]);
  });

  it("retains maker priority after a partial fill and rests a GTC residual", () => {
    const maker = resting({ id: "maker", remainingQuantity: 8, prioritySequence: 4n });
    const first = matchOrder([maker], incoming({ id: "first", remainingQuantity: 3 }), PAYOUT);
    expect(first.restingOrders[0]).toEqual(expect.objectContaining({ id: "maker", remainingQuantity: 5, prioritySequence: 4n }));

    const second = matchOrder(first.restingOrders, incoming({ id: "second", remainingQuantity: 7 }), PAYOUT);
    expect(second.fills).toEqual([
      expect.objectContaining({ makerOrderId: "maker", quantity: 5 }),
    ]);
    expect(second.disposition).toBe("PARTIALLY_FILLED_AND_RESTING");
    expect(second.restingOrders).toContainEqual(expect.objectContaining({ id: "second", remainingQuantity: 2 }));
  });

  it("executes at the resting maker price", () => {
    const result = matchOrder(
      [resting({ id: "maker", limitPriceMilli: 40_000n, remainingQuantity: 5 })],
      incoming({ limitPriceMilli: 45_000n, remainingQuantity: 5 }),
      PAYOUT,
    );
    expect(result.fills[0]?.priceMilli).toBe(40_000n);
  });

  it("matches an incoming sell against the highest bids first", () => {
    const result = matchOrder(
      [
        resting({ id: "lower", side: "BUY", limitPriceMilli: 40_000n, remainingQuantity: 4 }),
        resting({ id: "higher", side: "BUY", limitPriceMilli: 42_000n, remainingQuantity: 3 }),
      ],
      incoming({ side: "SELL", limitPriceMilli: 39_000n, remainingQuantity: 5 }),
      PAYOUT,
    );

    expect(result.fills.map((fill) => [fill.makerOrderId, fill.quantity, fill.priceMilli])).toEqual([
      ["higher", 3, 42_000n],
      ["lower", 2, 40_000n],
    ]);
    expect(result.restingOrders).toEqual([
      expect.objectContaining({ id: "lower", remainingQuantity: 2 }),
    ]);
  });

  it("never rests IOC and leaves a failed FOK book unchanged", () => {
    const book = [resting({ id: "maker", remainingQuantity: 4 })];
    const ioc = matchOrder(book, incoming({ remainingQuantity: 10, timeInForce: "IOC" }), PAYOUT);
    expect(ioc.disposition).toBe("PARTIALLY_FILLED_AND_CANCELED");
    expect(ioc.filledQuantity).toBe(4);
    expect(ioc.canceledQuantity).toBe(6);
    expect(ioc.restingOrders).toEqual([]);

    const fok = matchOrder(book, incoming({ remainingQuantity: 5, timeInForce: "FOK" }), PAYOUT);
    expect(fok.disposition).toBe("FOK_NOT_FILLABLE");
    expect(fok.fills).toEqual([]);
    expect(fok.restingOrders).toEqual(book);
  });

  it("rejects marketable post-only orders without mutating the book", () => {
    const book = [resting({ id: "maker", limitPriceMilli: 49_000n })];
    const result = matchOrder(book, incoming({ postOnly: true }), PAYOUT);
    expect(result.disposition).toBe("POST_ONLY_WOULD_TRADE");
    expect(result.fills).toEqual([]);
    expect(result.restingOrders).toEqual(book);
  });

  it("rejects post-only before STP so own liquidity cannot bypass maker-only", () => {
    const own = resting({ id: "own", ownerId: "same", stpOwnerId: "same", limitPriceMilli: 49_000n });
    const result = matchOrder(
      [own],
      incoming({
        ownerId: "same",
        stpOwnerId: "same",
        postOnly: true,
        selfTradePrevention: "CANCEL_RESTING",
      }),
      PAYOUT,
    );

    expect(result.disposition).toBe("POST_ONLY_WOULD_TRADE");
    expect(result.preventedOrderIds).toEqual([]);
    expect(result.restingOrders).toEqual([own]);
  });

  it("prevents self trades with each deterministic policy", () => {
    const own = resting({ id: "own", ownerId: "same", stpOwnerId: "same" });

    const cancelAggressor = matchOrder(
      [own],
      incoming({ ownerId: "same", stpOwnerId: "same", selfTradePrevention: "CANCEL_AGGRESSOR" }),
      PAYOUT,
    );
    expect(cancelAggressor.disposition).toBe("SELF_TRADE_PREVENTED");
    expect(cancelAggressor.restingOrders).toEqual([own]);

    const cancelResting = matchOrder(
      [own],
      incoming({ ownerId: "same", stpOwnerId: "same", selfTradePrevention: "CANCEL_RESTING" }),
      PAYOUT,
    );
    expect(cancelResting.disposition).toBe("RESTING");
    expect(cancelResting.restingOrders.map((order) => order.id)).toEqual(["taker"]);

    const cancelBoth = matchOrder(
      [own],
      incoming({ ownerId: "same", stpOwnerId: "same", selfTradePrevention: "CANCEL_BOTH" }),
      PAYOUT,
    );
    expect(cancelBoth.disposition).toBe("SELF_TRADE_PREVENTED");
    expect(cancelBoth.restingOrders).toEqual([]);
  });

  it("uses identical STP traversal for FOK preflight and execution", () => {
    const own = resting({ id: "own", ownerId: "same", stpOwnerId: "same", remainingQuantity: 4, prioritySequence: 1n });
    const external = resting({ id: "external", remainingQuantity: 5, prioritySequence: 2n });
    const base = incoming({
      ownerId: "same",
      stpOwnerId: "same",
      remainingQuantity: 5,
      timeInForce: "FOK",
    });

    const cancelResting = matchOrder(
      [external, own],
      { ...base, selfTradePrevention: "CANCEL_RESTING" },
      PAYOUT,
    );
    expect(cancelResting.disposition).toBe("FILLED");
    expect(cancelResting.preventedOrderIds).toEqual(["own"]);
    expect(cancelResting.fills).toEqual([expect.objectContaining({ makerOrderId: "external", quantity: 5 })]);
    expect(cancelResting.restingOrders).toEqual([]);

    for (const policy of ["CANCEL_AGGRESSOR", "CANCEL_BOTH"] as const) {
      const result = matchOrder([external, own], { ...base, selfTradePrevention: policy }, PAYOUT);
      expect(result.disposition).toBe("FOK_NOT_FILLABLE");
      expect(result.fills).toEqual([]);
      expect(result.preventedOrderIds).toEqual([]);
      expect(result.restingOrders).toEqual(sortBook([external, own]));
    }
  });

  it("leaves a failed FOK byte-for-byte economically unchanged under cancel-resting STP", () => {
    const book = [
      resting({ id: "own", ownerId: "same", stpOwnerId: "same", remainingQuantity: 7, prioritySequence: 1n }),
      resting({ id: "external", remainingQuantity: 4, prioritySequence: 2n }),
    ];
    const before = structuredClone(book);
    const result = matchOrder(
      book,
      incoming({
        ownerId: "same",
        stpOwnerId: "same",
        remainingQuantity: 5,
        timeInForce: "FOK",
        selfTradePrevention: "CANCEL_RESTING",
      }),
      PAYOUT,
    );

    expect(result.disposition).toBe("FOK_NOT_FILLABLE");
    expect(result.restingOrders).toEqual(sortBook(before));
    expect(book).toEqual(before);
  });

  it("conserves incoming and maker quantities across partial multi-level fills", () => {
    const book = [
      resting({ id: "one", remainingQuantity: 2, limitPriceMilli: 40_000n, prioritySequence: 1n }),
      resting({ id: "two", remainingQuantity: 3, limitPriceMilli: 41_000n, prioritySequence: 2n }),
      resting({ id: "outside", remainingQuantity: 9, limitPriceMilli: 46_000n, prioritySequence: 3n }),
    ];
    const requested = 8;
    const result = matchOrder(
      book,
      incoming({ remainingQuantity: requested, limitPriceMilli: 45_000n, timeInForce: "IOC" }),
      PAYOUT,
    );

    const fillTotal = result.fills.reduce((sum, fill) => sum + fill.quantity, 0);
    expect(fillTotal).toBe(result.filledQuantity);
    expect(result.filledQuantity + result.canceledQuantity + result.remainingQuantity).toBe(requested);
    expect(result.restingOrders.reduce((sum, order) => sum + order.remainingQuantity, 0)).toBe(9);
    expect(result.restingOrders).toEqual([expect.objectContaining({ id: "outside", remainingQuantity: 9 })]);
  });

  it("rejects malformed execution-policy values instead of applying inconsistent defaults", () => {
    expect(() =>
      matchOrder([], incoming({ selfTradePrevention: "INVALID" as IncomingOrder["selfTradePrevention"] }), PAYOUT),
    ).toThrow("unsupported selfTradePrevention");
    expect(() =>
      matchOrder([], incoming({ postOnly: undefined as unknown as boolean }), PAYOUT),
    ).toThrow("postOnly must be a boolean");
  });

  it("is deterministic and does not mutate caller-owned orders", () => {
    const book = Object.freeze([
      Object.freeze(resting({ id: "later", remainingQuantity: 4, prioritySequence: 2n })),
      Object.freeze(resting({ id: "earlier", remainingQuantity: 4, prioritySequence: 1n })),
    ]);
    const order = Object.freeze(incoming({ remainingQuantity: 6 }));

    const first = matchOrder(book, order, PAYOUT);
    const second = matchOrder(book, order, PAYOUT);
    expect(first).toEqual(second);
    expect(book.map((entry) => entry.remainingQuantity)).toEqual([4, 4]);
    expect(order.remainingQuantity).toBe(6);
  });
});
