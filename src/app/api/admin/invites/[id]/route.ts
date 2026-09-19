import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { assertAdmin } from "@/lib/admin-service";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    await consumeRateLimit(prisma, `admin-invite-revoke:${user.id}`, 60, 60_000);
    const { id } = paramsSchema.parse(await context.params);
    const invite = await prisma.$transaction(async (tx) => {
      const current = await tx.registrationInvite.findUnique({ where: { id } });
      if (!current) throw new ApiError(404, "INVITE_NOT_FOUND", "Invitation not found.");
      if (current.status === "REVOKED") return current;
      const revoked = await tx.registrationInvite.update({ where: { id }, data: { status: "REVOKED" } });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id, action: "REGISTRATION_INVITE_REVOKED", entityType: "REGISTRATION_INVITE", entityId: id,
          metadata: JSON.stringify({ label: revoked.label, useCount: revoked.useCount, maxUses: revoked.maxUses }),
        },
      });
      return revoked;
    });
    return jsonResponse({ invite: { id: invite.id, status: invite.status } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
