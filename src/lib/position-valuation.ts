import type { Market, Position, Prisma } from "@prisma/client";
import { assertDatabaseFinancialMarket, DATABASE_MARKET_FILTER } from "./market-backend";
import { liquidationValueMilli, sideLiquidationValuesMilli } from "./portfolio";
import { marketProbabilityBps } from "./view-models";
import { selectMarketMark } from "./order-book-pricing";
import { valueOrderBookPosition, type ValuationOrder } from "./order-book-valuation";

type Holding = Position & { market: Market };
export interface PositionValuation {
  valueMilli: bigint;
  yes: bigint;
  no: bigint;
  unfilledYes: number;
  unfilledNo: number;
  probabilityYesBps: number | null;
  method: "ORDER_BOOK_LIQUIDATION" | "MARKET_MAKER";
}

/** Call inside the same snapshot used to read holdings and cash. */
export async function loadPositionValuations(tx: Prisma.TransactionClient, positions: Holding[], now = new Date()): Promise<Map<string, PositionValuation>> {
  for (const position of positions) assertDatabaseFinancialMarket(position.market);
  const marketIds = [...new Set(positions.filter((p) => p.market.pricingModel === "ORDER_BOOK").map((p) => p.marketId))];
  const byMarket = new Map<string, ValuationOrder[]>();
  const lastByMarket = new Map<string, { canonicalYesPriceMilli: bigint; createdAt: Date }>();
  if (marketIds.length) {
    const [orders, markets] = await Promise.all([
      tx.marketOrder.findMany({
        where: { market: DATABASE_MARKET_FILTER, marketId: { in: marketIds }, user: { status: "ACTIVE", role: "USER" }, status: { in: ["OPEN", "PARTIALLY_FILLED"] }, remainingQuantity: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        select: { marketId: true, userId: true, stpOwnerId: true, bookSide: true, limitPriceMilli: true, remainingQuantity: true, status: true, expiresAt: true },
      }),
      tx.market.findMany({ where: { ...DATABASE_MARKET_FILTER, id: { in: marketIds } }, select: { id: true, orderFills: { orderBy: { tradeSequence: "desc" }, take: 1, select: { canonicalYesPriceMilli: true, createdAt: true } } } }),
    ]);
    for (const order of orders) {
      const group = byMarket.get(order.marketId) ?? [];
      group.push(order); byMarket.set(order.marketId, group);
    }
    for (const market of markets) if (market.orderFills[0]) lastByMarket.set(market.id, market.orderFills[0]);
  }
  return new Map(positions.map((position): [string, PositionValuation] => {
    const market = position.market;
    const approvedOutcome = market.status === "VOID" ? "VOID"
      : market.status === "RESOLVED" || market.status === "RESOLVING" ? market.resolution : null;
    if (approvedOutcome === "YES" || approvedOutcome === "NO" || approvedOutcome === "VOID") {
      // Approved liabilities have a fixed value until their atomic payout
      // moves that value into cash, regardless of the market's pricing model.
      return [position.id, {
        ...valueOrderBookPosition({ market, position, orders: [], now }),
        probabilityYesBps: approvedOutcome === "YES" ? 10_000 : approvedOutcome === "NO" ? 0 : 5_000,
        method: market.pricingModel === "ORDER_BOOK" ? "ORDER_BOOK_LIQUIDATION" : "MARKET_MAKER",
      }];
    }
    if (market.pricingModel !== "ORDER_BOOK") {
      return [position.id, { valueMilli: liquidationValueMilli(position), ...sideLiquidationValuesMilli(position), unfilledYes: 0, unfilledNo: 0, probabilityYesBps: marketProbabilityBps(market), method: "MARKET_MAKER" }];
    }
    const orders = byMarket.get(market.id) ?? [];
    const last = lastByMarket.get(market.id);
    const live = market.status === "OPEN" && market.acceptingOrders && market.closesAt > now;
    const levels = (side: string) => live ? orders.filter((o) => o.bookSide === side).map((o) => ({ priceMilli: o.limitPriceMilli, quantity: BigInt(o.remainingQuantity) })) : [];
    const mark = selectMarketMark({ bids: levels("BUY"), asks: levels("SELL"), payoutMilli: market.payoutMilli, nowMs: BigInt(now.getTime()), lastTrade: last ? { priceMilli: last.canonicalYesPriceMilli, executedAtMs: BigInt(last.createdAt.getTime()) } : null, settlementPriceMilli: null });
    return [position.id, { ...valueOrderBookPosition({ market, position, orders, now }), probabilityYesBps: mark.displayProbabilityBps === null ? null : Number(mark.displayProbabilityBps), method: "ORDER_BOOK_LIQUIDATION" }];
  }));
}
