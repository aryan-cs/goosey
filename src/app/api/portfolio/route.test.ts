import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  transaction: vi.fn(),
  tx: {
    user: { findUniqueOrThrow: vi.fn() },
    ledgerAccount: { findUnique: vi.fn() },
    position: { findMany: vi.fn() },
    trade: { findMany: vi.fn() },
    orderReservation: { findMany: vi.fn() },
    marketOrder: { findMany: vi.fn() },
    market: { findMany: vi.fn() },
  },
}));

// No root delegates or real database: every read must use the supplied snapshot.
vi.mock("@/lib/market-service", async () => {
  const { jsonStringify } = await import("@/lib/serializers");
  return {
    prisma: { $transaction: mocks.transaction },
    requireUser: mocks.requireUser,
    jsonResponse: (body: unknown) => new Response(jsonStringify(body), {
      headers: { "content-type": "application/json" },
    }),
    apiErrorResponse: (error: { status?: number; code?: string }) =>
      Response.json({ code: error.code ?? "INTERNAL_ERROR" }, { status: error.status ?? 500 }),
  };
});
vi.mock("@/lib/position-valuation", async (original) => {
  const actual = await original<typeof import("@/lib/position-valuation")>();
  return { ...actual, loadPositionValuations: vi.fn(actual.loadPositionValuations) };
});

import { loadPositionValuations } from "@/lib/position-valuation";
import { GET } from "./route";

const now = new Date("2026-09-19T12:00:00.000Z");
function holding(id = "holding-yes", yesShares = 5, noShares = 0) {
  return {
    id, userId: "participant", marketId: "market-1", yesShares, noShares,
    netCostMilli: 2_000n, yesCostBasisMilli: 2_000n, noCostBasisMilli: 0n,
    realizedPnlMilli: -123n, updatedAt: now,
    market: {
      id: "market-1", slug: "goose-race", title: "Goose race", pricingModel: "ORDER_BOOK",
      status: "OPEN", resolution: null as string | null, acceptingOrders: true,
      closesAt: new Date("2099-01-01"), payoutMilli: 1_000n, feeBps: 100,
    },
  };
}
function order(bookSide: string, limitPriceMilli: bigint, remainingQuantity: number, userId = "other") {
  return {
    marketId: "market-1", userId, stpOwnerId: userId, bookSide, limitPriceMilli,
    remainingQuantity, status: "OPEN", expiresAt: null,
  };
}
const request = () => new NextRequest("http://localhost/api/portfolio");

describe("portfolio API snapshot and executable valuations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "participant" });
    mocks.transaction.mockImplementation(async (operation: (tx: typeof mocks.tx) => unknown) => operation(mocks.tx));
    mocks.tx.user.findUniqueOrThrow.mockResolvedValue({ balanceMilli: 999_999n, realizedPnlMilli: -77n });
    mocks.tx.ledgerAccount.findUnique.mockResolvedValue({ balanceMilli: 10_000n });
    mocks.tx.position.findMany.mockResolvedValue([holding()]);
    mocks.tx.trade.findMany.mockResolvedValue([]);
    mocks.tx.orderReservation.findMany.mockResolvedValue([
      { cashAccount: { balanceMilli: 700n } }, { cashAccount: { balanceMilli: 300n } }, { cashAccount: null },
    ]);
    mocks.tx.marketOrder.findMany.mockResolvedValue([order("BUY", 600n, 2)]);
    mocks.tx.market.findMany.mockResolvedValue([{ id: "market-1", orderFills: [] }]);
  });

  it("binds cash, reservations, holdings, trades and real valuation reads to one serializable transaction", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "Serializable", maxWait: 5_000, timeout: 20_000,
    });
    expect(loadPositionValuations).toHaveBeenCalledExactlyOnceWith(mocks.tx, [holding()]);
    expect(mocks.tx.user.findUniqueOrThrow).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "participant" } }));
    expect(mocks.tx.ledgerAccount.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: "participant", purpose: "USER_FEATHERS" } },
    }));
    expect(mocks.tx.position.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "participant", OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] },
    }));
    expect(mocks.tx.trade.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "participant" }, take: 100 }));
    expect(mocks.tx.orderReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "participant", cashAccountId: { not: null } },
    }));
    expect(mocks.tx.marketOrder.findMany).toHaveBeenCalledOnce();
    expect(mocks.tx.market.findMany).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      cashMilli: "10000", reservedCashMilli: "1000", totalCashMilli: "11000",
      positionValueMilli: "1188", equityMilli: "12188", realizedPnlMilli: "-77",
      positions: [{
        id: "holding-yes", executableValueMilli: "1188", valuationMethod: "ORDER_BOOK_LIQUIDATION",
        unfilledYesShares: 3, unfilledNoShares: 0, unrealizedPnlMilli: "-812",
        netCostMilli: "2000", yesCostBasisMilli: "2000", noCostBasisMilli: "0",
        realizedPnlMilli: "-123", updatedAt: now.toISOString(),
      }], trades: [],
    });
  });

  it("batches multiple holdings and values NO at complemented executable prices less fees, excluding own depth", async () => {
    mocks.tx.position.findMany.mockResolvedValue([holding(), holding("holding-no", 0, 4)]);
    mocks.tx.marketOrder.findMany.mockResolvedValue([
      order("BUY", 600n, 2), order("SELL", 700n, 2), order("SELL", 100n, 100, "participant"),
    ]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      positionValueMilli: "1782", equityMilli: "12782",
      positions: [
        { executableValueMilli: "1188", unfilledYesShares: 3 },
        { executableValueMilli: "594", unfilledNoShares: 2, unfilledYesShares: 0 },
      ],
    });
    expect(mocks.tx.marketOrder.findMany).toHaveBeenCalledOnce();
    expect(mocks.tx.market.findMany).toHaveBeenCalledOnce();
  });

  it("preserves a missing market mark and unfilled holdings instead of inventing value", async () => {
    mocks.tx.marketOrder.findMany.mockResolvedValue([]);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      positionValueMilli: "0", equityMilli: "11000",
      positions: [{ market: { probabilityYesBps: null }, executableValueMilli: "0", unfilledYesShares: 5 }],
    });
  });

  it.each([
    ["YES", "1001", 10_000], ["NO", "2002", 0], ["VOID", "1501", 5_000],
  ])("uses approved %s payout through the real adapter while settlement is pending", async (resolution, value, probability) => {
    const position = holding("pending", 1, 2);
    Object.assign(position.market, { status: "RESOLVING", resolution, acceptingOrders: false, payoutMilli: 1_001n });
    mocks.tx.position.findMany.mockResolvedValue([position]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      positionValueMilli: value, equityMilli: String(11_000n + BigInt(value)),
      positions: [{
        market: { status: "RESOLVING", resolution, probabilityYesBps: probability },
        executableValueMilli: value, unfilledYesShares: 0, unfilledNoShares: 0,
      }],
    });
    expect(loadPositionValuations).toHaveBeenCalledWith(mocks.tx, [position]);
  });

  it("keeps exact large cash integers and the legacy wallet fallback with empty holdings", async () => {
    mocks.tx.ledgerAccount.findUnique.mockResolvedValue(null);
    mocks.tx.user.findUniqueOrThrow.mockResolvedValue({ balanceMilli: 9_007_199_254_740_993n, realizedPnlMilli: 0n });
    mocks.tx.position.findMany.mockResolvedValue([]);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({
      cashMilli: "9007199254740993", reservedCashMilli: "1000", totalCashMilli: "9007199254741993",
      equityMilli: "9007199254741993", positionValueMilli: "0", positions: [],
    });
    expect(mocks.tx.marketOrder.findMany).not.toHaveBeenCalled();
    expect(mocks.tx.market.findMany).not.toHaveBeenCalled();
  });

  it("returns no portfolio data and performs no reads when authentication fails", async () => {
    mocks.requireUser.mockRejectedValue({ status: 401, code: "UNAUTHORIZED" });
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "UNAUTHORIZED" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(loadPositionValuations).not.toHaveBeenCalled();
    for (const delegate of Object.values(mocks.tx)) {
      for (const read of Object.values(delegate)) expect(read).not.toHaveBeenCalled();
    }
  });

  it("does not return a partial cash snapshot if valuation fails", async () => {
    mocks.tx.marketOrder.findMany.mockRejectedValueOnce(new Error("snapshot unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "INTERNAL_ERROR" });
  });
});
