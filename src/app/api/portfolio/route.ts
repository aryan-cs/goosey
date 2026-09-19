import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { loadPositionValuations } from "@/lib/position-valuation";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const [record, account, positions, trades, reservations, valuations] = await runSerializableTransaction(prisma, async (tx) => {
      const result = await Promise.all([
      tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { balanceMilli: true, realizedPnlMilli: true },
      }),
      tx.ledgerAccount.findUnique({
        where: {
          ownerType_ownerId_purpose: {
            ownerType: "USER",
            ownerId: user.id,
            purpose: "USER_FEATHERS",
          },
        },
        select: { balanceMilli: true },
      }),
      tx.position.findMany({
        where: { userId: user.id, OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }] },
        include: { market: true },
        orderBy: { updatedAt: "desc" },
      }),
      tx.trade.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 100,
        include: { market: { select: { slug: true, title: true } } },
      }),
      tx.orderReservation.findMany({
        where: { userId: user.id, cashAccountId: { not: null } },
        select: { cashAccount: { select: { balanceMilli: true } } },
      }),
      ]);
      return [...result, await loadPositionValuations(tx, result[2])] as const;
    });
    const items = positions.map((position) => {
      const valuation = valuations.get(position.id)!;
      const executableValueMilli = valuation.valueMilli;
      return {
        id: position.id,
        market: {
          id: position.market.id,
          slug: position.market.slug,
          title: position.market.title,
          status: position.market.status,
          resolution: position.market.resolution,
          probabilityYesBps: valuation.probabilityYesBps,
        },
        yesShares: position.yesShares,
        noShares: position.noShares,
        netCostMilli: position.netCostMilli,
        yesCostBasisMilli: position.yesCostBasisMilli,
        noCostBasisMilli: position.noCostBasisMilli,
        executableValueMilli,
        valuationMethod: valuation.method,
        unfilledYesShares: valuation.unfilledYes,
        unfilledNoShares: valuation.unfilledNo,
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
    const reservedCashMilli = reservations.reduce((sum, reservation) => sum + (reservation.cashAccount?.balanceMilli ?? 0n), 0n);
    return jsonResponse({
      cashMilli,
      reservedCashMilli,
      totalCashMilli: cashMilli + reservedCashMilli,
      positionValueMilli,
      equityMilli: cashMilli + reservedCashMilli + positionValueMilli,
      realizedPnlMilli: record.realizedPnlMilli,
      positions: items,
      trades,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
