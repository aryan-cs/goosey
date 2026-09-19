import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { jsonSafe } from "@/lib/serializers";
import { loadMarketMarks } from "@/lib/market-marks";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
const slugSchema = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const slug = slugSchema.parse((await context.params).slug);
    const user = await getAuthenticatedUser(request);
    return await runSerializableTransaction(prisma, async (tx) => {
      const market = await tx.market.findUnique({
        where: { slug },
        include: {
          createdBy: { select: { username: true, displayName: true } },
          priceHistory: { orderBy: { createdAt: "desc" }, take: 1 },
          orderFills: {
            orderBy: { tradeSequence: "desc" },
            take: 1,
            select: { createdAt: true, canonicalYesPriceMilli: true },
          },
        },
      });
      if (!market || (market.status === "DRAFT" && user?.role !== "ADMIN")) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      const mark = (await loadMarketMarks(tx, [market])).get(market.id)!;
      const { orderFills, ...summary } = market;
      return NextResponse.json(
        jsonSafe({
          ...summary,
          collateralAccountId: undefined,
          createdById: undefined,
          probabilityYesBps: mark.probabilityYesBps,
          probabilitySource: mark.source,
          probabilityStale: mark.stale,
          priceHistory: market.pricingModel === "ORDER_BOOK"
            ? orderFills.map((fill) => ({
                createdAt: fill.createdAt,
                yesProbabilityBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)),
              }))
            : market.priceHistory,
        }),
        { headers: { "Cache-Control": "private, no-store" } },
      );
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
