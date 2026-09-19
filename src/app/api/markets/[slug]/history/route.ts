import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { jsonSafe } from "@/lib/serializers";
import { getAuthenticatedUser } from "@/lib/auth";
import { boundedPriceHistory } from "@/lib/price-history";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();
const querySchema = z
  .object({
    range: z.enum(["1D", "1W", "1M", "ALL"]).default("1W"),
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
  })
  .strict();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const market = await prisma.market.findUnique({ where: { slug }, select: { id: true, status: true } });
    const user = market?.status === "DRAFT" ? await getAuthenticatedUser(request) : null;
    if (!market || (market.status === "DRAFT" && user?.role !== "ADMIN")) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    const duration = { "1D": 86_400_000, "1W": 604_800_000, "1M": 2_592_000_000 } as const;
    const since = query.range === "ALL" ? undefined : new Date(Date.now() - duration[query.range]);
    const [rawSnapshots, priorSnapshot, trades] = await Promise.all([
      prisma.marketPriceSnapshot.findMany({
        where: { marketId: market.id, ...(since ? { createdAt: { gte: since } } : {}) },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      since ? prisma.marketPriceSnapshot.findFirst({
        where: { marketId: market.id, createdAt: { lt: since } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      }) : Promise.resolve(null),
      prisma.trade.findMany({
        where: { marketId: market.id, ...(since ? { createdAt: { gte: since } } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: Math.min(query.limit, 100),
        select: {
          id: true,
          side: true,
          action: true,
          quantity: true,
          amountMilli: true,
          feeMilli: true,
          priceBeforeBps: true,
          priceAfterBps: true,
          createdAt: true,
        },
      }),
    ]);
    const sourceSnapshots = priorSnapshot ? [priorSnapshot, ...rawSnapshots] : rawSnapshots;
    const snapshots = boundedPriceHistory(
      sourceSnapshots.map((snapshot) => ({ ...snapshot, timestamp: snapshot.createdAt, probabilityYesBps: snapshot.yesProbabilityBps })),
      query.limit,
    ).map((snapshot) => ({
      id: snapshot.id,
      marketId: snapshot.marketId,
      yesProbabilityBps: snapshot.probabilityYesBps,
      createdAt: snapshot.createdAt,
    }));
    return NextResponse.json(
      jsonSafe({
        snapshots,
        trades,
        range: query.range,
        rangeStart: since ?? null,
        sampledFrom: sourceSnapshots.length,
        downsampled: sourceSnapshots.length > snapshots.length,
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
