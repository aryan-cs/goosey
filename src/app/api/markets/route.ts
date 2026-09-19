import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { chronologicalPriceHistory } from "@/lib/price-history";
import { decodeCursor, encodeCursor, jsonSafe } from "@/lib/serializers";
import { yesProbabilityBps } from "@/lib/trading";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    status: z.enum(["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOID"]).default("OPEN"),
    category: z.string().trim().min(1).max(50).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    sort: z.enum(["trending", "volume", "newest", "closing"]).default("trending"),
    limit: z.coerce.number().int().min(1).max(50).default(24),
    cursor: z.string().max(500).optional(),
  })
  .strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const parsed = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const cursor = decodeCursor(parsed.cursor);
    if (parsed.cursor && !cursor?.id) throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");

    const where: Prisma.MarketWhereInput = {
      status: parsed.status,
      ...(parsed.status === "OPEN" ? { closesAt: { gt: new Date() } } : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.q
        ? {
            OR: [
              { title: { contains: parsed.q } },
              { shortTitle: { contains: parsed.q } },
              { description: { contains: parsed.q } },
            ],
          }
        : {}),
    };
    const orderBy: Prisma.MarketOrderByWithRelationInput[] =
      parsed.sort === "newest"
        ? [{ createdAt: "desc" }, { id: "desc" }]
        : parsed.sort === "closing"
          ? [{ closesAt: "asc" }, { id: "asc" }]
          : parsed.sort === "volume"
            ? [{ volumeMilli: "desc" }, { id: "asc" }]
            : [{ featured: "desc" }, { traderCount: "desc" }, { volumeMilli: "desc" }, { id: "asc" }];

    const rows = await prisma.market.findMany({
      where,
      orderBy,
      take: parsed.limit + 1,
      ...(cursor?.id ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      select: {
        id: true,
        slug: true,
        title: true,
        shortTitle: true,
        description: true,
        category: true,
        status: true,
        resolution: true,
        featured: true,
        color: true,
        icon: true,
        closesAt: true,
        resolvesAt: true,
        yesShares: true,
        noShares: true,
        liquidityParameter: true,
        payoutMilli: true,
        volumeMilli: true,
        traderCount: true,
        commentCount: true,
        version: true,
        updatedAt: true,
        priceHistory: {
          orderBy: { createdAt: "desc" },
          take: 30,
          select: { createdAt: true, yesProbabilityBps: true },
        },
      },
    });
    const hasMore = rows.length > parsed.limit;
    const items = rows.slice(0, parsed.limit).map((market) => {
      const probability = yesProbabilityBps(
        market.yesShares,
        market.noShares,
        market.liquidityParameter,
      );
      const { priceHistory, ...summary } = market;
      return {
        ...summary,
        probabilityYesBps: probability,
        priceHistory: chronologicalPriceHistory(
          priceHistory.map((point) => ({ timestamp: point.createdAt, probabilityYesBps: point.yesProbabilityBps })),
          probability,
          market.updatedAt,
        ),
      };
    });
    return NextResponse.json(
      jsonSafe({
        items,
        nextCursor: hasMore ? encodeCursor({ id: items.at(-1)!.id }) : null,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
