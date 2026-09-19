import { NextRequest } from "next/server";
import { z } from "zod";
import { badgeTokenHash, requireBadgeAccess } from "@/lib/badge-access";
import { ApiError, apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { readJsonObject } from "@/lib/http";
import { createTradeQuote, quoteRequestSchema } from "@/lib/trading";

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  try {
    const hash = badgeTokenHash(request);
    const body = quoteRequestSchema.parse(await readJsonObject(request));
    const user = await requireBadgeAccess(hash);
    const slug = z.string().min(1).max(160).parse((await context.params).slug);
    const market = await prisma.market.findUnique({ where: { slug }, select: { id: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    return jsonResponse(await createTradeQuote({ ...body, userId: user.id, marketId: market.id,
      authorize: async (tx) => { await requireBadgeAccess(hash, tx, user.id); },
    }), { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}
