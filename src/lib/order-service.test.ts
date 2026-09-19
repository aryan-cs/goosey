import { describe, expect, it } from "vitest";

import { encodeCursor, jsonSafe } from "./serializers";
import {
  aggregateOrderLevels,
  parseListOrdersQuery,
  parseOrderBookQuery,
  serializePrivateOrder,
} from "./order-service";

describe("CLOB read query parsing", () => {
  it("uses canonical defaults and parses canonical integer limits", () => {
    expect(parseOrderBookQuery(new URLSearchParams())).toEqual({ depth: 100 });
    expect(parseOrderBookQuery(new URLSearchParams("depth=25"))).toEqual({ depth: 25 });
    expect(parseListOrdersQuery(new URLSearchParams())).toEqual({ limit: 50 });
  });

  it.each(["depth=1&depth=2", "other=1", "depth=01", "depth=1e2", "depth=1.0", "depth=%20"])(
    "rejects ambiguous order-book query %s",
    (query) => expect(() => parseOrderBookQuery(new URLSearchParams(query))).toThrow(),
  );

  it("supports unique repeated statuses while rejecting ambiguous parameters", () => {
    expect(parseListOrdersQuery(new URLSearchParams("status=OPEN&status=FILLED&limit=20"))).toEqual({
      statuses: ["OPEN", "FILLED"],
      limit: 20,
    });
    expect(() => parseListOrdersQuery(new URLSearchParams("limit=10&limit=20"))).toThrow();
    expect(() => parseListOrdersQuery(new URLSearchParams("status=OPEN&status=OPEN"))).toThrow();
    expect(() => parseListOrdersQuery(new URLSearchParams("status=NOT_REAL"))).toThrow();
    expect(() => parseListOrdersQuery(new URLSearchParams("unknown=x"))).toThrow();
  });

  it("decodes a stable private-order cursor and rejects malformed cursor payloads", () => {
    const cursor = encodeCursor({
      createdAt: "2026-09-19T12:00:00.000Z",
      id: "order_12345678",
    });
    expect(parseListOrdersQuery(new URLSearchParams({ cursor }))).toEqual({
      cursor: {
        createdAt: new Date("2026-09-19T12:00:00.000Z"),
        id: "order_12345678",
      },
      limit: 50,
    });

    expect(() => parseListOrdersQuery(new URLSearchParams({ cursor: "not-a-cursor" }))).toThrow();
    expect(() => parseListOrdersQuery(new URLSearchParams({
      cursor: encodeCursor({ id: "order_12345678" }),
    }))).toThrow();
  });
});

describe("CLOB public aggregation", () => {
  it("uses bigint totals so aggregating valid rows cannot overflow number precision", () => {
    const maximum = 2_147_483_647;
    const levels = aggregateOrderLevels(
      [
        { limitPriceMilli: 42_000n, remainingQuantity: maximum },
        { limitPriceMilli: 42_000n, remainingQuantity: maximum },
        { limitPriceMilli: 41_000n, remainingQuantity: 1 },
      ],
      true,
      10,
    );
    expect(levels[0]).toEqual({
      priceMilli: 42_000n,
      quantity: 4_294_967_294n,
      orderCount: 2,
    });
    expect((jsonSafe(levels) as unknown[])[0]).toEqual({
      priceMilli: "42000",
      quantity: "4294967294",
      orderCount: 2,
    });
  });

  it("sorts levels best-first and applies depth after aggregation", () => {
    expect(
      aggregateOrderLevels(
        [
          { limitPriceMilli: 40n, remainingQuantity: 2 },
          { limitPriceMilli: 60n, remainingQuantity: 1 },
          { limitPriceMilli: 50n, remainingQuantity: 3 },
        ],
        false,
        2,
      ).map((level) => level.priceMilli),
    ).toEqual([40n, 50n]);
  });
});

describe("private order serialization", () => {
  it("returns the documented private shape without internal ownership or reservation fields", () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    const internal = {
      id: "ord_1",
      userId: "secret-user",
      marketId: "secret-market-id",
      stpOwnerId: "secret-beneficial-owner",
      reservedCashMilli: 99_999n,
      clientOrderId: "client_1",
      outcome: "YES",
      action: "BUY",
      bookSide: "BUY",
      limitPriceMilli: 42_000n,
      originalQuantity: 10,
      remainingQuantity: 4,
      filledQuantity: 6,
      canceledQuantity: 0,
      status: "PARTIALLY_FILLED",
      timeInForce: "GTC",
      postOnly: false,
      selfTradePrevention: "CANCEL_AGGRESSOR",
      cumulativeFeeMilli: 12n,
      acceptedSequence: 7n,
      prioritySequence: 7n,
      version: 2,
      expiresAt: null,
      terminalReason: null,
      terminalAt: null,
      createdAt: now,
      updatedAt: now,
      market: { slug: "fixture", title: "Fixture", payoutMilli: 100_000n },
    };

    const serialized = serializePrivateOrder(internal);
    expect(serialized).not.toHaveProperty("userId");
    expect(serialized).not.toHaveProperty("marketId");
    expect(serialized).not.toHaveProperty("stpOwnerId");
    expect(serialized).not.toHaveProperty("reservedCashMilli");
    expect(jsonSafe(serialized)).toMatchObject({
      orderId: "ord_1",
      limitPriceMilli: "42000",
      acceptedSequence: "7",
      createdAt: now.toISOString(),
      market: { payoutMilli: "100000" },
    });
  });
});
