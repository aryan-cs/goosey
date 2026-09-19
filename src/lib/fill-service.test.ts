import { describe, expect, it } from "vitest";

import { encodeCursor, jsonSafe } from "./serializers";
import { parseListFillsQuery, parsePublicTradesQuery, serializePrivateFill } from "./fill-service";

describe("private fill history", () => {
  it("parses strict filters and stable cursors", () => {
    const cursor = encodeCursor({ createdAt: "2026-09-19T12:00:00.000Z", id: "fill_12345678" });
    expect(parseListFillsQuery(new URLSearchParams({ marketSlug: "venue-wifi", role: "MAKER", limit: "20", cursor }))).toEqual({
      marketSlug: "venue-wifi",
      role: "MAKER",
      limit: 20,
      cursor: { createdAt: new Date("2026-09-19T12:00:00.000Z"), id: "fill_12345678" },
    });
    expect(parseListFillsQuery(new URLSearchParams())).toEqual({ limit: 50 });
  });

  it.each(["limit=01", "limit=201", "role=OTHER", "unknown=x", "limit=2&limit=3", "cursor=bad"])(
    "rejects ambiguous fill query %s",
    (query) => expect(() => parseListFillsQuery(new URLSearchParams(query))).toThrow(),
  );

  it("returns only the user's side of a fill with the correct outcome price and fee", () => {
    const fill = {
      id: "fill_12345678",
      canonicalYesPriceMilli: 62_000n,
      quantity: 3,
      makerFeeMilli: 12n,
      takerFeeMilli: 18n,
      matchType: "CROSS",
      tradeSequence: 9n,
      createdAt: new Date("2026-09-19T12:00:00.000Z"),
      market: { slug: "venue-wifi", title: "Venue Wi-Fi stays up", payoutMilli: 100_000n },
      makerOrder: { id: "order_maker", userId: "maker_user", clientOrderId: "maker_client", outcome: "NO", action: "BUY" },
      takerOrder: { id: "order_taker", userId: "taker_user", clientOrderId: "taker_client", outcome: "YES", action: "SELL" },
    };
    expect(jsonSafe(serializePrivateFill(fill, "maker_user"))).toMatchObject({
      role: "MAKER",
      orderId: "order_maker",
      outcome: "NO",
      executionPriceMilli: "38000",
      feeMilli: "12",
      tradeSequence: "9",
    });
    expect(serializePrivateFill(fill, "maker_user")).not.toHaveProperty("counterpartyUserId");
    expect(() => serializePrivateFill(fill, "unrelated_user")).toThrow();
  });
});

describe("public order-book trade tape", () => {
  it("uses market-bound opaque sequence cursors", () => {
    const cursor = encodeCursor({ marketSlug: "venue-wifi", tradeSequence: "42" });
    expect(parsePublicTradesQuery(new URLSearchParams({ limit: "25", cursor }), "venue-wifi")).toEqual({
      limit: 25,
      cursor: { marketSlug: "venue-wifi", tradeSequence: 42n },
    });
    expect(() => parsePublicTradesQuery(new URLSearchParams({ cursor }), "other-market")).toThrow();
    expect(() => parsePublicTradesQuery(new URLSearchParams("limit=1&limit=2"), "venue-wifi")).toThrow();
    expect(() => parsePublicTradesQuery(new URLSearchParams("unknown=x"), "venue-wifi")).toThrow();
  });
});
