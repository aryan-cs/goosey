import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), findBySlug: vi.fn(), user: vi.fn() }));

vi.mock("@/lib/unified-market-repository", () => ({
  createUnifiedMarketReadRepository: () => ({ list: mocks.list, findBySlug: mocks.findBySlug }),
}));
vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: mocks.user }));

import { ApiError } from "@/lib/market-service";
import { GET as listMarkets } from "./route";
import { GET as getMarket } from "./[slug]/route";

const editorial = {
  id: "market-1",
  slug: "campus-market",
  title: "Will the geese win?",
  shortTitle: "Geese win",
  description: "A campus forecast.",
  rules: "Resolves from the published result.",
  resolutionSource: "Official result",
  category: "Campus",
  featured: true,
  color: "gold",
  icon: "sparkles",
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
  updatedAt: new Date("2026-09-19T11:00:00.000Z"),
};

const finalizedMarket = {
  executionBackend: "SOLANA" as const,
  href: "/markets/campus-market",
  editorial,
  financial: {
    source: "solana-finalized" as const,
    finalizedSlot: 44n,
    coverageRevision: 3,
    coverageUpdatedAt: new Date("2026-09-19T11:00:00.000Z"),
    marketAddress: "must-not-leak",
    chainMarketId: 77n,
    payoutMilli: 100_000n,
    feeBps: 25,
    closesAt: new Date("2026-10-01T00:00:00.000Z"),
    resolvesAt: new Date("2026-10-02T00:00:00.000Z"),
    status: "OPEN" as const,
    acceptingOrders: true,
    resolution: null,
    probabilityYesBps: 6_200,
    probabilitySource: "MID" as const,
    bids: [{ priceMilli: 61_000n, quantity: 2n }],
    asks: [{ priceMilli: 63_000n, quantity: 4n }],
    traderCount: 8,
    recentTrades: [{ signature: "private-signature", slot: 43n, logIndex: 1, quantity: 3n, yesPriceMilli: 62_000n }],
    recentTradeWindowComplete: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user.mockResolvedValue(null);
  mocks.list.mockResolvedValue([finalizedMarket]);
  mocks.findBySlug.mockResolvedValue(finalizedMarket);
});

describe("unified public market routes", () => {
  it("serves a finalized market through the normal list shape without custody or chain branding", async () => {
    const response = await listMarkets(new NextRequest("http://localhost:8080/api/markets"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.items[0]).toMatchObject({
      id: "market-1",
      slug: "campus-market",
      probabilityYesBps: 6_200,
      payoutMilli: "100000",
      orderBook: { bids: [{ priceMilli: "61000", quantity: "2" }] },
      recentTrades: [{ id: "private-signature:1", quantity: "3", yesPriceMilli: "62000" }],
    });
    expect(body.items[0]).not.toHaveProperty("marketAddress");
    expect(body.items[0]).not.toHaveProperty("chainMarketId");
    expect(body.items[0]).not.toHaveProperty("finalizedSlot");
    expect(JSON.stringify(body)).not.toMatch(/wallet|phantom|solana/i);
  });

  it("serves the same finalized data at the normal detail route with private no-store caching", async () => {
    const response = await getMarket(
      new NextRequest("http://localhost:8080/api/markets/campus-market"),
      { params: Promise.resolve({ slug: "campus-market" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({ slug: "campus-market", probabilitySource: "MID", pricingModel: "ORDER_BOOK" });
    expect(body).not.toHaveProperty("marketAddress");
    expect(body).not.toHaveProperty("coverageRevision");
  });

  it.each(["list", "detail"] as const)("fails closed when the finalized %s projection is unavailable", async kind => {
    const error = new ApiError(503, "SOLANA_PROJECTION_UNAVAILABLE", "Finalized projection unavailable.");
    if (kind === "list") mocks.list.mockRejectedValue(error);
    else mocks.findBySlug.mockRejectedValue(error);
    const response = kind === "list"
      ? await listMarkets(new NextRequest("http://localhost:8080/api/markets"))
      : await getMarket(new NextRequest("http://localhost:8080/api/markets/campus-market"), {
          params: Promise.resolve({ slug: "campus-market" }),
        });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("SOLANA_PROJECTION_UNAVAILABLE");
  });
});
