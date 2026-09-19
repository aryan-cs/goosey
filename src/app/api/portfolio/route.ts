import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { executablePositionValue, yesProbabilityBps } from "@/lib/trading";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const [record, account, positions, trades] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { balanceMilli: true, realizedPnlMilli: true },
      }),
      prisma.ledgerAccount.findUnique({
        where: {
          ownerType_ownerId_purpose: {
            ownerType: "USER",
            ownerId: user.id,
            purpose: "USER_FEATHERS",
          },
        },
        select: { balanceMilli: true },
      }),
      prisma.position.findMany({
        where: { userId: user.id, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] },
        include: { market: true },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.trade.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: { market: { select: { slug: true, title: true } } },
      }),
    ]);
    const items = positions.map((position) => {
      const executableValueMilli = executablePositionValue(position.market, position);
      return {
        id: position.id,
        market: {
          id: position.market.id,
          slug: position.market.slug,
          title: position.market.title,
          status: position.market.status,
          resolution: position.market.resolution,
          probabilityYesBps: yesProbabilityBps(
            position.market.yesShares,
            position.market.noShares,
            position.market.liquidityParameter,
          ),
        },
        yesShares: position.yesShares,
        noShares: position.noShares,
        netCostMilli: position.netCostMilli,
        yesCostBasisMilli: position.yesCostBasisMilli,
        noCostBasisMilli: position.noCostBasisMilli,
        executableValueMilli,
        unrealizedPnlMilli: executableValueMilli - position.netCostMilli,
        realizedPnlMilli: position.realizedPnlMilli,
        updatedAt: position.updatedAt,
      };
    });
    const positionValueMilli = items.reduce(
      (sum, position) => sum + position.executableValueMilli,
      0n,
    );
    const cashMilli = account?.balanceMilli ?? record.balanceMilli;
    return jsonResponse({
      cashMilli,
      positionValueMilli,
      equityMilli: cashMilli + positionValueMilli,
      realizedPnlMilli: record.realizedPnlMilli,
      positions: items,
      trades,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
