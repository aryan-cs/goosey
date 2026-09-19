import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { jsonSafe } from "@/lib/serializers";
import { yesProbabilityBps } from "@/lib/trading";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
const slugSchema = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const slug = slugSchema.parse((await context.params).slug);
    const market = await prisma.market.findUnique({
      where: { slug },
      include: {
        createdBy: { select: { username: true, displayName: true } },
        priceHistory: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    const user = market?.status === "DRAFT" ? await getAuthenticatedUser(request) : null;
    if (!market || (market.status === "DRAFT" && user?.role !== "ADMIN")) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    return NextResponse.json(
      jsonSafe({
        ...market,
        collateralAccountId: undefined,
        createdById: undefined,
        probabilityYesBps: yesProbabilityBps(
          market.yesShares,
          market.noShares,
          market.liquidityParameter,
        ),
      }),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
