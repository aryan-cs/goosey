import { DATABASE_MARKET_FILTER } from "./market-backend";
import type { Prisma } from "@prisma/client";

/** Counts executions, not submitted orders or contracts. Call inside a read snapshot. */
export async function loadTradingActivity(tx: Prisma.TransactionClient, userIds: readonly string[], marketWhere: Prisma.MarketWhereInput = DATABASE_MARKET_FILTER) {
  const ids = [...new Set(userIds)];
  const result = new Map(ids.map((id) => [id, { trades: 0, marketsTraded: 0 }]));
  if (!ids.length) return result;
  const [legacy, orders] = await Promise.all([
    tx.trade.groupBy({ by: ["userId", "marketId"], where: { market: marketWhere, userId: { in: ids } }, _count: { _all: true } }),
    tx.marketOrder.findMany({
      where: { market: marketWhere, userId: { in: ids }, filledQuantity: { gt: 0 } },
      select: { userId: true, marketId: true, _count: { select: { makerFills: true, takerFills: true } } },
    }),
  ]);
  const markets = new Map(ids.map((id) => [id, new Set<string>()]));
  const add = (userId: string, marketId: string, trades: number) => {
    const user = result.get(userId);
    if (!user || trades === 0) return;
    user.trades += trades;
    markets.get(userId)!.add(marketId);
  };
  for (const trade of legacy) add(trade.userId, trade.marketId, trade._count._all);
  for (const order of orders) add(order.userId, order.marketId, order._count.makerFills + order._count.takerFills);
  for (const [id, user] of result) user.marketsTraded = markets.get(id)!.size;
  return result;
}
