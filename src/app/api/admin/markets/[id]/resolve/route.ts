import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, createResolutionProposal, resolutionSchema } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const idempotencyKey = parseIdempotencyKey(request);
    const { id } = paramsSchema.parse(await context.params);
    const resolution = resolutionSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const result = await createResolutionProposal({ actorUserId: user.id, marketId: id, idempotencyKey, resolution });
    return jsonResponse(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
