import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { NextResponse } from "next/server";

import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { chronologicalPriceHistory } from "@/lib/price-history";
import { loadMarketMarks } from "@/lib/market-marks";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

const marketSelect = {
  id: true,
  slug: true,
  title: true,
  shortTitle: true,
  category: true,
  status: true,
  executionBackend: true, collateralAccountId: true, pricingModel: true,
  acceptingOrders: true,
  resolution: true,
  payoutMilli: true,
  featured: true,
  closesAt: true,
  yesShares: true,
  noShares: true,
  liquidityParameter: true,
  volumeMilli: true,
  traderCount: true,
  commentCount: true,
  updatedAt: true,
  event: { select: { slug: true, shortTitle: true } },
  orderFills: {
    orderBy: { tradeSequence: "desc" as const },
    take: 30,
    select: { createdAt: true, canonicalYesPriceMilli: true },
  },
  priceHistory: {
    orderBy: { createdAt: "desc" as const },
    take: 30,
    select: { createdAt: true, yesProbabilityBps: true },
  },
} as const;

type Marks = Awaited<ReturnType<typeof loadMarketMarks>>;

function marketCard<T extends { id: string; collateralAccountId: string | null; pricingModel: string; payoutMilli: bigint; updatedAt: Date; orderFills: Array<{ createdAt: Date; canonicalYesPriceMilli: bigint }>; priceHistory: Array<{ createdAt: Date; yesProbabilityBps: number }> }>(market: T, marks: Marks) {
  const mark = marks.get(market.id)!;
  const probability = mark.probabilityYesBps;
  const { priceHistory, orderFills, collateralAccountId, ...card } = market;
  void collateralAccountId; // Used only by the boundary check, not public output.
  return {
    ...card,
    probabilityYesBps: probability,
    probabilitySource: mark.source,
    probabilityStale: mark.stale,
    priceHistory: market.pricingModel === "ORDER_BOOK"
      ? orderFills.slice().reverse().map((fill) => ({
          timestamp: fill.createdAt,
          probabilityYesBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)),
        }))
      : probability === null ? [] : chronologicalPriceHistory(
          priceHistory.map((point) => ({ timestamp: point.createdAt, probabilityYesBps: point.yesProbabilityBps })),
          probability,
          market.updatedAt,
        ),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const now = new Date();
    return await runSerializableTransaction(prisma, async (tx) => {
      const [featuredEvents, trending, newest, closingSoon, moverCandidates] = await Promise.all([
        tx.marketEvent.findMany({
          where: { featured: true, endsAt: { gt: now }, markets: { some: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } } } },
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          take: 6,
          select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, startsAt: true, endsAt: true, _count: { select: { markets: { where: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } } } } } },
        }),
        tx.market.findMany({ where: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } }, orderBy: [{ featured: "desc" }, { traderCount: "desc" }, { volumeMilli: "desc" }, { id: "asc" }], take: 12, select: marketSelect }),
        tx.market.findMany({ where: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12, select: marketSelect }),
        tx.market.findMany({ where: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } }, orderBy: [{ closesAt: "asc" }, { id: "asc" }], take: 12, select: marketSelect }),
        tx.market.findMany({
          where: { ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now } },
          take: 100,
          select: marketSelect,
        }),
      ]);
      const markets = [...new Map([...trending, ...newest, ...closingSoon, ...moverCandidates].map((market) => [market.id, market])).values()];
      const marks = await loadMarketMarks(tx, markets, now);
      const movers = moverCandidates
        .flatMap((market) => {
          const card = marketCard(market, marks);
          const current = card.probabilityYesBps;
          if (current === null) return [];
          const prior = card.priceHistory.at(-2)?.probabilityYesBps ?? current;
          return [{ ...card, changeBps: current - prior }];
        })
        .sort((left, right) => Math.abs(right.changeBps) - Math.abs(left.changeBps) || left.title.localeCompare(right.title))
        .slice(0, 12);
      return jsonResponse({
        generatedAt: now,
        featuredEvents: featuredEvents.map((event) => ({ ...event, marketCount: event._count.markets, _count: undefined })),
        trending: trending.map((market) => marketCard(market, marks)),
        newest: newest.map((market) => marketCard(market, marks)),
        closingSoon: closingSoon.map((market) => marketCard(market, marks)),
        movers,
      }, { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } });
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
