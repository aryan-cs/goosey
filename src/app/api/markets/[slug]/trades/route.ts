import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { db } from "@/lib/db";
import {
  ApiError,
  apiErrorResponse,
  jsonResponse,
  parseIdempotencyKey,
  requireUser,
} from "@/lib/market-service";
import { executeTrade, executeTradeSchema } from "@/lib/trading";

const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const body = executeTradeSchema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    const idempotencyKey = parseIdempotencyKey(request);
    const { slug } = paramsSchema.parse(await context.params);
    const market = await db.market.findUnique({ where: { slug }, select: { id: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    const result = await executeTrade({
      userId: user.id,
      authRequest: request,
      marketId: market.id,
      idempotencyKey,
      ...body,
    });
    return jsonResponse(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
