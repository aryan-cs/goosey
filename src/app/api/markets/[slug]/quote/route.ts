import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";
import { createTradeQuote, quoteRequestSchema } from "@/lib/trading";

const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const body = quoteRequestSchema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    const { slug } = paramsSchema.parse(await context.params);
    const market = await db.market.findUnique({ where: { slug }, select: { id: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    const quote = await createTradeQuote({ userId: user.id, authRequest: request, marketId: market.id, ...body });
    return jsonResponse(quote, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
