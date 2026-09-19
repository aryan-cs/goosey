import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAdmin } from "@/lib/admin-service";
import { attachMarketToEvent, eventMembershipSchema } from "@/lib/event-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";

const paramsSchema = z
  .object({ id: z.string().cuid(), marketId: z.string().cuid() })
  .strict();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; marketId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id, marketId } = paramsSchema.parse(await context.params);
    const { expectedMarketVersion, expectedEventVersion } = eventMembershipSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const result = await attachMarketToEvent({
      actorUserId: user.id,
      eventId: id,
      marketId,
      expectedMarketVersion,
      expectedEventVersion,
    });
    return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
