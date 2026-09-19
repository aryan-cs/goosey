import { assertMutationSession } from "@/lib/mutation-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, requireActiveAdmin } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const bodySchema = z.object({ action: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().min(3).max(1_000) }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    await consumeRateLimit(prisma, `admin-suggestion:${user.id}`, 60, 60_000);
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await readJsonObject(request));
    const result = await prisma.$transaction(async (tx) => {
      await assertMutationSession(tx, request, user.id);
      await requireActiveAdmin(tx, user.id);
      const suggestion = await tx.marketSuggestion.findUnique({ where: { id } });
      if (!suggestion) throw new ApiError(404, "SUGGESTION_NOT_FOUND", "Suggestion not found.");
      const status = body.action === "APPROVE" ? "APPROVED" : "REJECTED";
      const claimed = await tx.marketSuggestion.updateMany({
        where: { id, status: "PENDING" },
        data: { status, reviewNote: body.note, reviewedById: user.id, reviewedAt: new Date() },
      });
      if (claimed.count !== 1) throw new ApiError(409, "SUGGESTION_ALREADY_REVIEWED", "This suggestion has already been reviewed.");
      await tx.notification.create({
        data: {
          userId: suggestion.userId,
          type: "SUGGESTION_REVIEWED",
          title: `Market suggestion ${status.toLowerCase()}`,
          body: body.note,
          href: "/markets/suggest",
        },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: `MARKET_SUGGESTION_${status}`,
          entityType: "MARKET_SUGGESTION",
          entityId: id,
          metadata: JSON.stringify({ note: body.note }),
        },
      });
      return tx.marketSuggestion.findUniqueOrThrow({ where: { id } });
    });
    return jsonResponse({ suggestion: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
