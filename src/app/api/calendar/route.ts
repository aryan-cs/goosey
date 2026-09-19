import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { yesProbabilityBps } from "@/lib/trading";

export const dynamic = "force-dynamic";

const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const querySchema = z.object({ from: instant.optional(), to: instant.optional(), category: z.string().trim().min(1).max(60).optional() }).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const from = query.from ?? new Date();
    const to = query.to ?? new Date(from.getTime() + 7 * 24 * 60 * 60_000);
    if (to <= from || to.getTime() - from.getTime() > 31 * 24 * 60 * 60_000) {
      throw new ApiError(400, "INVALID_CALENDAR_RANGE", "Calendar ranges must be positive and no longer than 31 days.");
    }
    const [markets, events] = await Promise.all([
      prisma.market.findMany({
        where: { status: { not: "DRAFT" }, closesAt: { gte: from, lt: to }, ...(query.category ? { category: query.category } : {}) },
        orderBy: [{ closesAt: "asc" }, { id: "asc" }],
        take: 500,
        select: { id: true, slug: true, title: true, shortTitle: true, category: true, status: true, closesAt: true, resolvesAt: true, yesShares: true, noShares: true, liquidityParameter: true, event: { select: { slug: true, shortTitle: true } } },
      }),
      prisma.marketEvent.findMany({
        where: { startsAt: { lt: to }, endsAt: { gte: from }, markets: { some: { status: { not: "DRAFT" } } }, ...(query.category ? { category: query.category } : {}) },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        take: 100,
        select: { id: true, slug: true, title: true, shortTitle: true, description: true, category: true, startsAt: true, endsAt: true },
      }),
    ]);
    return jsonResponse({
      from,
      to,
      events,
      markets: markets.map((market) => ({ ...market, probabilityYesBps: yesProbabilityBps(market.yesShares, market.noShares, market.liquidityParameter) })),
    }, { headers: { "Cache-Control": "public, max-age=15, stale-while-revalidate=45" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
