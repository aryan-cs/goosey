import { NextRequest } from "next/server";
import { z } from "zod";
import { badgeTokenHash, requireBadgeAccess } from "@/lib/badge-access";
import { ApiError, apiErrorResponse, jsonResponse, prisma, parseIdempotencyKey } from "@/lib/market-service";
import { readJsonObject } from "@/lib/http";
import { executeTrade, executeTradeSchema } from "@/lib/trading";

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  try {
    const hash = badgeTokenHash(request);
    const body = executeTradeSchema.parse(await readJsonObject(request));
    const user = await requireBadgeAccess(hash);
    const slug = z.string().min(1).max(160).parse((await context.params).slug);
    const market = await prisma.market.findUnique({ where: { slug }, select: { id: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    return jsonResponse(await executeTrade({ ...body, userId: user.id, marketId: market.id,
      idempotencyKey: parseIdempotencyKey(request),
      authorize: async (tx) => { await requireBadgeAccess(hash, tx, user.id); },
    }), { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}
