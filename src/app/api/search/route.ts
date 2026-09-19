import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { loadMarketMarks } from "@/lib/market-marks";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

function textRank(query: string, values: Array<string | null | undefined>): number {
  const needle = query.toLocaleLowerCase("en-CA");
  const normalized = values.filter((value): value is string => Boolean(value)).map((value) => value.toLocaleLowerCase("en-CA"));
  if (normalized.some((value) => value === needle)) return 0;
  if (normalized.some((value) => value.startsWith(needle))) return 1;
  if (normalized.some((value) => value.includes(needle))) return 2;
  return 3;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return await runSerializableTransaction(prisma, async (tx) => {
      const [markets, events, profiles] = await Promise.all([
        tx.market.findMany({
          where: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" }, OR: [{ title: { contains: query.q } }, { shortTitle: { contains: query.q } }, { description: { contains: query.q } }, { category: { contains: query.q } }] },
          take: 50,
          select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, status: true, executionBackend: true, collateralAccountId: true, pricingModel: true, acceptingOrders: true, resolution: true, payoutMilli: true, closesAt: true, yesShares: true, noShares: true, liquidityParameter: true, volumeMilli: true },
        }),
        tx.marketEvent.findMany({
          where: { markets: { some: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" } } }, OR: [{ title: { contains: query.q } }, { shortTitle: { contains: query.q } }, { description: { contains: query.q } }, { category: { contains: query.q } }] },
          take: 30,
          select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, startsAt: true, endsAt: true, _count: { select: { markets: { where: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" } } } } } },
        }),
        tx.user.findMany({
          where: { role: "USER", status: "ACTIVE", profilePublic: true, OR: [{ username: { contains: query.q } }, { displayName: { contains: query.q } }, { bio: { contains: query.q } }] },
          take: 30,
          select: { id: true, username: true, displayName: true, bio: true },
        }),
      ]);
      const marks = await loadMarketMarks(tx, markets);
      const rankedMarkets = markets
        .sort((left, right) => textRank(query.q, [left.title, left.shortTitle, left.category]) - textRank(query.q, [right.title, right.shortTitle, right.category]) || left.title.localeCompare(right.title))
        .slice(0, query.limit)
        .map((market) => {
          const mark = marks.get(market.id)!;
          return { ...market, collateralAccountId: undefined, resultType: "market" as const, probabilityYesBps: mark.probabilityYesBps, probabilitySource: mark.source, probabilityStale: mark.stale };
        });
      const rankedEvents = events
        .sort((left, right) => textRank(query.q, [left.title, left.shortTitle, left.category]) - textRank(query.q, [right.title, right.shortTitle, right.category]) || left.title.localeCompare(right.title))
        .slice(0, query.limit)
        .map((event) => ({ ...event, resultType: "event" as const, marketCount: event._count.markets, _count: undefined }));
      const rankedProfiles = profiles
        .sort((left, right) => textRank(query.q, [left.username, left.displayName]) - textRank(query.q, [right.username, right.displayName]) || left.username.localeCompare(right.username))
        .slice(0, query.limit)
        .map((profile) => ({ ...profile, resultType: "profile" as const }));
      return jsonResponse({ query: query.q, markets: rankedMarkets, events: rankedEvents, profiles: rankedProfiles }, { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } });
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
