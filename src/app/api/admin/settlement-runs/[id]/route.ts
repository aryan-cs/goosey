import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAdmin } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";
import { getSettlementRun, processSettlementRun } from "@/lib/settlement-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const processSchema = z.object({ batchSize: z.number().int().min(1).max(100).default(100) }).strict();

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    return jsonResponse(await getSettlementRun(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    const { batchSize } = processSchema.parse(await readJsonObject(request));
    const result = await processSettlementRun({ actorUserId: user.id, runId: id, batchSize });
    return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
