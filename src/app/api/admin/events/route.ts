import { NextRequest, NextResponse } from "next/server";

import { assertAdmin } from "@/lib/admin-service";
import { createAdminEvent, createEventSchema } from "@/lib/event-service";
import { readJsonObject } from "@/lib/http";
import {
  apiErrorResponse,
  jsonResponse,
  parseIdempotencyKey,
  requireUser,
} from "@/lib/market-service";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const idempotencyKey = parseIdempotencyKey(request);
    const event = createEventSchema.parse(await readJsonObject(request));
    const result = await createAdminEvent({
      actorUserId: user.id,
      idempotencyKey,
      event,
    });
    return jsonResponse(result, {
      status: result.replayed ? 200 : 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
