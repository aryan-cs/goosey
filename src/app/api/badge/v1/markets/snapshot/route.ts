import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { badgeTokenHash, requireBadgeAccess } from "@/lib/badge-access";
import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { ApiError, apiErrorResponse, consumeRateLimit, prisma } from "@/lib/market-service";
import { loadMarketMarks } from "@/lib/market-marks";
import { jsonSafe } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

const SNAPSHOT_LIMIT = 16;

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

/**
 * Versioned, bounded full-state poll for a native HTTPS badge. This endpoint
 * intentionally does not claim delta/stream semantics: every 200 response is a
 * coherent replacement snapshot, while 304 means the caller's saved snapshot
 * remains current. The device fetches a selected market's public history when
 * opening its graph.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tokenHash = badgeTokenHash(request);
    const rateLimitKey = createHash("sha256").update(`badge-snapshot:${tokenHash}`).digest("base64url");
    await consumeRateLimit(prisma, rateLimitKey, 12, 60_000);
    const snapshot = await runSerializableTransaction(prisma, async (tx) => {
      const user = await requireBadgeAccess(tokenHash, tx);
      const now = new Date();
      const [ledger, cachedUser, markets] = await Promise.all([
        tx.ledgerAccount.findUnique({
          where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" } },
          select: { balanceMilli: true, updatedAt: true },
        }),
        tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { balanceMilli: true, updatedAt: true } }),
        tx.market.findMany({
          where: {
            ...DATABASE_MARKET_FILTER, status: "OPEN", closesAt: { gt: now },
            pricingModel: "LMSR", acceptingOrders: true,
          },
          orderBy: [{ featured: "desc" }, { traderCount: "desc" }, { volumeMilli: "desc" }, { id: "asc" }],
          take: SNAPSHOT_LIMIT + 1,
          select: {
            id: true, slug: true, shortTitle: true, status: true, closesAt: true,
            volumeMilli: true, version: true, updatedAt: true, acceptingOrders: true, executionBackend: true,
            collateralAccountId: true, pricingModel: true, resolution: true,
            yesShares: true, noShares: true, liquidityParameter: true, payoutMilli: true,
          },
        }),
      ]);
      if (markets.length > SNAPSHOT_LIMIT) {
        throw new ApiError(409, "BADGE_CATALOG_TOO_LARGE", `The badge catalog supports at most ${SNAPSHOT_LIMIT} tradeable markets.`);
      }
      const positions = markets.length ? await tx.position.findMany({
        where: { userId: user.id, marketId: { in: markets.map((market) => market.id) } },
        select: {
          yesShares: true, noShares: true, reservedYesShares: true, reservedNoShares: true, updatedAt: true,
          market: { select: { slug: true } },
        },
      }) : [];
      const marks = await loadMarketMarks(tx, markets, now);
      const holdings = new Map(positions.map((position) => [position.market.slug, position]));
      const capturedAt = new Date(Math.max(
        (ledger?.updatedAt ?? cachedUser.updatedAt).getTime(),
        cachedUser.updatedAt.getTime(),
        ...markets.map((market) => market.updatedAt.getTime()),
        ...positions.map((position) => position.updatedAt.getTime()),
      ));
      return {
        protocolVersion: 1,
        type: "snapshot",
        capturedAt,
        account: { username: user.username, balanceMilli: ledger?.balanceMilli ?? cachedUser.balanceMilli },
        markets: markets.map((market) => {
          const position = holdings.get(market.slug);
          return {
            slug: market.slug, title: market.shortTitle, status: market.status, closesAt: market.closesAt,
            probabilityYesBps: marks.get(market.id)!.probabilityYesBps,
            volumeMilli: market.volumeMilli, version: market.version,
            holding: {
              yesShares: position?.yesShares ?? 0, noShares: position?.noShares ?? 0,
              reservedYesShares: position?.reservedYesShares ?? 0,
              reservedNoShares: position?.reservedNoShares ?? 0,
            },
          };
        }),
      };
    });
    const body = JSON.stringify(jsonSafe(snapshot));
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    const headers = {
      "Cache-Control": "private, no-cache, max-age=0, must-revalidate",
      ETag: etag,
      Vary: "Authorization",
      "X-Goosey-Badge-Protocol": "1",
    };
    if (matchesEtag(request.headers.get("if-none-match"), etag)) return new NextResponse(null, { status: 304, headers });
    return new NextResponse(body, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
