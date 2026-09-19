import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { yesProbabilityBps } from "@/lib/trading";

const paramsSchema = z.object({ slug: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const event = await prisma.marketEvent.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        title: true,
        shortTitle: true,
        description: true,
        category: true,
        featured: true,
        color: true,
        icon: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        updatedAt: true,
        markets: {
          where: { status: { not: "DRAFT" } },
          orderBy: [{ featured: "desc" }, { closesAt: "asc" }],
          select: { id: true, slug: true, title: true, shortTitle: true, description: true, status: true, resolution: true, closesAt: true, resolvesAt: true, yesShares: true, noShares: true, liquidityParameter: true, payoutMilli: true, volumeMilli: true, traderCount: true, commentCount: true },
        },
      },
    });
    if (!event || event.markets.length === 0) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
    return jsonResponse({
      event: {
        ...event,
        markets: event.markets.map((market) => ({ ...market, probabilityYesBps: yesProbabilityBps(market.yesShares, market.noShares, market.liquidityParameter) })),
      },
    }, { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
