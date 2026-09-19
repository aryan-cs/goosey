import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { loadMarketMarks } from "@/lib/market-marks";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const querySchema = z.object({ from: instant.optional(), to: instant.optional(), category: z.string().trim().min(1).max(60).optional() }).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    for (const key of request.nextUrl.searchParams.keys()) {
      if (request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_REQUEST", "Calendar parameters cannot be repeated.");
      }
    }
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const from = query.from ?? new Date();
    const to = query.to ?? new Date(from.getTime() + 7 * 24 * 60 * 60_000);
    if (to <= from || to.getTime() - from.getTime() > 31 * 24 * 60 * 60_000) {
      throw new ApiError(400, "INVALID_CALENDAR_RANGE", "Calendar ranges must be positive and no longer than 31 days.");
    }
    return await runSerializableTransaction(prisma, async (tx) => {
      const [markets, events] = await Promise.all([
        tx.market.findMany({
          where: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" }, closesAt: { gte: from, lt: to }, ...(query.category ? { category: query.category } : {}) },
          orderBy: [{ closesAt: "asc" }, { id: "asc" }],
          take: 500,
          select: { id: true, slug: true, title: true, shortTitle: true, category: true, status: true, executionBackend: true, collateralAccountId: true, pricingModel: true, acceptingOrders: true, resolution: true, payoutMilli: true, closesAt: true, resolvesAt: true, yesShares: true, noShares: true, liquidityParameter: true, event: { select: { slug: true, shortTitle: true } } },
        }),
        tx.marketEvent.findMany({
          where: { startsAt: { lt: to }, endsAt: { gte: from }, markets: { some: { ...DATABASE_MARKET_FILTER, status: { not: "DRAFT" } } }, ...(query.category ? { category: query.category } : {}) },
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          take: 100,
          select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, startsAt: true, endsAt: true },
        }),
      ]);
      const marks = await loadMarketMarks(tx, markets);
      return jsonResponse({
        from,
        to,
        events,
        markets: markets.map((market) => {
          const mark = marks.get(market.id)!;
          return { ...market, collateralAccountId: undefined, probabilityYesBps: mark.probabilityYesBps, probabilitySource: mark.source, probabilityStale: mark.stale };
        }),
      }, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" } });
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
