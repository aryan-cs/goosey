import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, lifecycleReasonSchema, transitionAdminMarket } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    const { reason, expectedVersion } = lifecycleReasonSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    return jsonResponse(await transitionAdminMarket({ actorUserId: user.id, marketId: id, action: "RESUME", reason, expectedVersion }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
