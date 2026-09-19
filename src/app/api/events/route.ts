import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { yesProbabilityBps } from "@/lib/trading";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  category: z.string().trim().min(1).max(60).optional(),
  timing: z.enum(["live", "upcoming", "past", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(24),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const now = new Date();
    const events = await prisma.marketEvent.findMany({
      where: {
        ...(query.category ? { category: query.category } : {}),
        ...(query.timing === "live" ? { startsAt: { lte: now }, endsAt: { gt: now } } : {}),
        ...(query.timing === "upcoming" ? { startsAt: { gt: now } } : {}),
        ...(query.timing === "past" ? { endsAt: { lte: now } } : {}),
        markets: { some: { status: { not: "DRAFT" } } },
      },
      orderBy: [{ featured: "desc" }, { startsAt: "asc" }, { id: "asc" }],
      take: query.limit,
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
          select: { id: true, slug: true, shortTitle: true, status: true, yesShares: true, noShares: true, liquidityParameter: true, closesAt: true, volumeMilli: true },
        },
      },
    });
    return jsonResponse({
      items: events.map((event) => ({
        ...event,
        markets: event.markets.map((market) => ({ ...market, probabilityYesBps: yesProbabilityBps(market.yesShares, market.noShares, market.liquidityParameter) })),
      })),
    }, { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
