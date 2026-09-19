import { NextRequest } from "next/server";
import { badgeTokenHash, requireBadgeAccess } from "@/lib/badge-access";
import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export async function GET(request: NextRequest) {
  try {
    const hash = badgeTokenHash(request);
    return await runSerializableTransaction(prisma, async (tx) => {
      const user = await requireBadgeAccess(hash, tx);
      const [account, record, positions] = await Promise.all([
        tx.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" } }, select: { balanceMilli: true } }),
        tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { balanceMilli: true } }),
        tx.position.findMany({ where: { userId: user.id }, select: { yesShares: true, noShares: true, reservedYesShares: true, reservedNoShares: true, market: { select: { slug: true } } } }),
      ]);
      return jsonResponse({ userId: user.id, username: user.username, balanceMilli: account?.balanceMilli ?? record.balanceMilli, positions });
    });
  } catch (error) { return apiErrorResponse(error); }
}
