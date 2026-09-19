import { NextResponse } from "next/server";

import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { chronologicalPriceHistory } from "@/lib/price-history";
import { yesProbabilityBps } from "@/lib/trading";

export const dynamic = "force-dynamic";

const marketSelect = {
  id: true,
  slug: true,
  title: true,
  shortTitle: true,
  category: true,
  status: true,
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
  priceHistory: {
    orderBy: { createdAt: "desc" as const },
    take: 30,
    select: { createdAt: true, yesProbabilityBps: true },
  },
} as const;

function marketCard<T extends { yesShares: number; noShares: number; liquidityParameter: number; updatedAt: Date; priceHistory: Array<{ createdAt: Date; yesProbabilityBps: number }> }>(market: T) {
  const probability = yesProbabilityBps(market.yesShares, market.noShares, market.liquidityParameter);
  const { priceHistory, ...card } = market;
  return {
    ...card,
    probabilityYesBps: probability,
    priceHistory: chronologicalPriceHistory(
      priceHistory.map((point) => ({ timestamp: point.createdAt, probabilityYesBps: point.yesProbabilityBps })),
      probability,
      market.updatedAt,
    ),
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const now = new Date();
    const [featuredEvents, trending, newest, closingSoon, moverCandidates] = await Promise.all([
      prisma.marketEvent.findMany({
        where: { featured: true, endsAt: { gt: now }, markets: { some: { status: "OPEN", closesAt: { gt: now } } } },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: 6,
        select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, startsAt: true, endsAt: true, _count: { select: { markets: { where: { status: "OPEN", closesAt: { gt: now } } } } } },
      }),
      prisma.market.findMany({ where: { status: "OPEN", closesAt: { gt: now } }, orderBy: [{ featured: "desc" }, { traderCount: "desc" }, { volumeMilli: "desc" }, { id: "asc" }], take: 12, select: marketSelect }),
      prisma.market.findMany({ where: { status: "OPEN", closesAt: { gt: now } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12, select: marketSelect }),
      prisma.market.findMany({ where: { status: "OPEN", closesAt: { gt: now } }, orderBy: [{ closesAt: "asc" }, { id: "asc" }], take: 12, select: marketSelect }),
      prisma.market.findMany({
        where: { status: "OPEN", closesAt: { gt: now } },
        take: 100,
        select: marketSelect,
      }),
    ]);
    const movers = moverCandidates
      .map((market) => {
        const current = market.priceHistory[0]?.yesProbabilityBps ?? yesProbabilityBps(market.yesShares, market.noShares, market.liquidityParameter);
        const prior = market.priceHistory[1]?.yesProbabilityBps ?? current;
        return { ...marketCard(market), changeBps: current - prior };
      })
      .sort((left, right) => Math.abs(right.changeBps) - Math.abs(left.changeBps) || left.title.localeCompare(right.title))
      .slice(0, 12);
    return jsonResponse({
      generatedAt: now,
      featuredEvents: featuredEvents.map((event) => ({ ...event, marketCount: event._count.markets, _count: undefined })),
      trending: trending.map(marketCard),
      newest: newest.map(marketCard),
      closingSoon: closingSoon.map(marketCard),
      movers,
    }, { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
