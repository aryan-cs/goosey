import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http";
import { createAdminMarket, createMarketSchema, assertAdmin } from "@/lib/admin-service";
import { apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const idempotencyKey = parseIdempotencyKey(request);
    const market = createMarketSchema.parse(await readJsonObject(request));
    const result = await createAdminMarket({ actorUserId: user.id, idempotencyKey, market });
    return jsonResponse(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
