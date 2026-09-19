import type { Market, Prisma } from "@prisma/client";
import { assertDatabaseFinancialMarket, DATABASE_MARKET_FILTER } from "./market-backend";

import { probabilityYesBps } from "./market-maker";
import { selectMarketMark, type PriceLevel } from "./order-book-pricing";

export type MarketMarkInput = Pick<
  Market,
  | "id"
  | "executionBackend"
  | "collateralAccountId"
  | "pricingModel"
  | "status"
  | "resolution"
  | "closesAt"
  | "acceptingOrders"
  | "payoutMilli"
  | "yesShares"
  | "noShares"
  | "liquidityParameter"
>;

export interface LoadedMarketMark {
  probabilityYesBps: number | null;
  source: "LMSR" | "MID" | "LAST" | "SETTLEMENT" | "NONE";
  stale: boolean;
}

type DepthRow = {
  marketId: string;
  bookSide: string;
  limitPriceMilli: bigint;
  _sum: { remainingQuantity: number | null };
};

function settlementMark(market: MarketMarkInput): LoadedMarketMark | null {
  const payoutKnown = market.status === "RESOLVED" || market.status === "RESOLVING";
  if (market.status === "VOID" || (payoutKnown && market.resolution === "VOID")) {
    return { probabilityYesBps: 5_000, source: "SETTLEMENT", stale: false };
  }
  if (!payoutKnown) return null;
  if (market.resolution === "YES") return { probabilityYesBps: 10_000, source: "SETTLEMENT", stale: false };
  if (market.resolution === "NO") return { probabilityYesBps: 0, source: "SETTLEMENT", stale: false };
  return { probabilityYesBps: null, source: "NONE", stale: false };
}

/** Load consistent probability marks for a heterogeneous batch of markets. */
export async function loadMarketMarks(
  tx: Prisma.TransactionClient,
  markets: readonly MarketMarkInput[],
  now = new Date(),
): Promise<Map<string, LoadedMarketMark>> {
  // Validate every input before deduplication (including duplicate IDs) or SQL.
  for (const market of markets) assertDatabaseFinancialMarket(market);
  const uniqueMarkets = [...new Map(markets.map((market) => [market.id, market])).values()];
  const orderBookMarkets = uniqueMarkets.filter((market) =>
    market.pricingModel === "ORDER_BOOK" && settlementMark(market) === null
  );
  const liveIds = orderBookMarkets
    .filter((market) => market.status === "OPEN" && market.acceptingOrders && market.closesAt > now)
    .map((market) => market.id);
  const orderBookIds = orderBookMarkets.map((market) => market.id);

  const [depthRows, latestRows] = await Promise.all([
    liveIds.length
      ? tx.marketOrder.groupBy({
          by: ["marketId", "bookSide", "limitPriceMilli"],
          where: {
            marketId: { in: liveIds },
            market: DATABASE_MARKET_FILTER,
            user: { status: "ACTIVE", role: "USER" },
            status: { in: ["OPEN", "PARTIALLY_FILLED"] },
            remainingQuantity: { gt: 0 },
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          _sum: { remainingQuantity: true },
        })
      : Promise.resolve([] as DepthRow[]),
    orderBookIds.length
      ? tx.market.findMany({
          where: { ...DATABASE_MARKET_FILTER, id: { in: orderBookIds } },
          select: {
            id: true,
            orderFills: {
              orderBy: { tradeSequence: "desc" },
              take: 1,
              select: { canonicalYesPriceMilli: true, createdAt: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const depthByMarket = new Map<string, { bids: PriceLevel[]; asks: PriceLevel[] }>();
  for (const row of depthRows) {
    const quantity = row._sum.remainingQuantity ?? 0;
    if (quantity <= 0 || (row.bookSide !== "BUY" && row.bookSide !== "SELL")) continue;
    const depth = depthByMarket.get(row.marketId) ?? { bids: [], asks: [] };
    const level = { priceMilli: row.limitPriceMilli, quantity: BigInt(quantity) };
    (row.bookSide === "BUY" ? depth.bids : depth.asks).push(level);
    depthByMarket.set(row.marketId, depth);
  }
  const latestByMarket = new Map(latestRows.flatMap((market) =>
    market.orderFills[0] ? [[market.id, market.orderFills[0]] as const] : []
  ));
  const liveSet = new Set(liveIds);

  return new Map(uniqueMarkets.map((market): [string, LoadedMarketMark] => {
    const settlement = settlementMark(market);
    if (settlement) return [market.id, settlement];
    if (market.pricingModel === "LMSR") {
      return [market.id, {
        probabilityYesBps: probabilityYesBps({
          yesQuantity: market.yesShares,
          noQuantity: market.noShares,
          liquidity: market.liquidityParameter,
          payoutMilli: market.payoutMilli,
        }),
        source: "LMSR",
        stale: false,
      }];
    }
    if (market.pricingModel !== "ORDER_BOOK") {
      return [market.id, { probabilityYesBps: null, source: "NONE", stale: false }];
    }
    const depth = liveSet.has(market.id)
      ? depthByMarket.get(market.id) ?? { bids: [], asks: [] }
      : { bids: [], asks: [] };
    const latest = latestByMarket.get(market.id);
    const selected = selectMarketMark({
      bids: depth.bids,
      asks: depth.asks,
      payoutMilli: market.payoutMilli,
      nowMs: BigInt(now.getTime()),
      lastTrade: latest
        ? { priceMilli: latest.canonicalYesPriceMilli, executedAtMs: BigInt(latest.createdAt.getTime()) }
        : null,
    });
    return [market.id, {
      probabilityYesBps: selected.displayProbabilityBps === null ? null : Number(selected.displayProbabilityBps),
      source: selected.source,
      stale: selected.stale,
    }];
  }));
}
