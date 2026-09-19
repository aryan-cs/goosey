import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPublicOrderBook: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock("@/lib/order-service", () => ({
  getPublicOrderBook: mocks.getPublicOrderBook,
  parseOrderBookQuery: vi.fn(() => ({ depth: 10 })),
}));

vi.mock("@/lib/market-service", () => ({
  prisma: {},
  consumeRateLimit: mocks.consumeRateLimit,
  jsonResponse: (body: unknown, init?: ResponseInit) => Response.json(
    JSON.parse(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value)),
    init,
  ),
  apiErrorResponse: (error: unknown) => Response.json({ error: String(error) }, { status: 500 }),
}));

vi.mock("@/lib/security", () => ({
  requestRateLimitKey: vi.fn(() => "orderbook-route-test"),
}));

import { NextRequest } from "next/server";

import { jsonStringify } from "@/lib/serializers";
import { GET } from "./route";

const baseBook = {
  marketSlug: "venue-wifi",
  marketStatus: "OPEN",
  sequence: 42n,
  payoutMilli: 100_000n,
  asks: [] as Array<{ priceMilli: bigint; quantity: bigint; orderCount: number }>,
};

function request() {
  return new NextRequest("http://localhost/api/v1/markets/venue-wifi/orderbook?depth=10");
}

function context() {
  return { params: Promise.resolve({ slug: "venue-wifi" }) };
}

describe("order-book representation validator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeRateLimit.mockResolvedValue(undefined);
  });

  it("changes the ETag when visible depth ages out without a sequence change", async () => {
    const nonempty = {
      ...baseBook,
      bids: [{ priceMilli: 60_000n, quantity: 2n, orderCount: 1 }],
    };
    const empty = { ...baseBook, bids: [] };
    mocks.getPublicOrderBook.mockResolvedValueOnce(nonempty).mockResolvedValueOnce(empty);

    const withDepth = await GET(request(), context());
    const afterExpiry = await GET(request(), context());

    expect(withDepth.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(withDepth.headers.get("pragma")).toBe("no-cache");
    expect(afterExpiry.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(withDepth.headers.get("etag")).toBe(
      `"book-${createHash("sha256").update(jsonStringify(nonempty)).digest("hex")}"`,
    );
    expect(afterExpiry.headers.get("etag")).not.toBe(withDepth.headers.get("etag"));
  });

  it("returns the same ETag for the same representation", async () => {
    const book = {
      ...baseBook,
      bids: [{ priceMilli: 60_000n, quantity: 2n, orderCount: 1 }],
    };
    mocks.getPublicOrderBook.mockResolvedValue(book);

    const first = await GET(request(), context());
    const second = await GET(request(), context());

    expect(first.headers.get("etag")).toBeTruthy();
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(second.headers.get("cache-control")).toBe("no-store, max-age=0");
  });
});
