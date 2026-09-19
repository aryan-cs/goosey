import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAdmin } from "@/lib/admin-service";
import { updateAdminEvent, updateEventSchema } from "@/lib/event-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    const update = updateEventSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const result = await updateAdminEvent({ actorUserId: user.id, eventId: id, update });
    return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
