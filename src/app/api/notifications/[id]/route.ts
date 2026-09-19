import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const { id } = paramsSchema.parse(await context.params);
    const changed = await prisma.notification.updateMany({ where: { id, userId: user.id }, data: { readAt: new Date() } });
    if (changed.count !== 1) throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "Notification not found.");
    return jsonResponse({ read: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
