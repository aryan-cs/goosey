import { assertMutationSession } from "@/lib/mutation-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, requireActiveAdmin } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const bodySchema = z.object({ action: z.enum(["DISMISS", "HIDE"]), note: z.string().trim().min(3).max(500) }).strict();

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true); assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params); const body = bodySchema.parse(await readJsonObject(request));
    const result = await prisma.$transaction(async (tx) => {
      await assertMutationSession(tx, request, user.id);
      await requireActiveAdmin(tx, user.id);
      const report = await tx.commentReport.findUnique({ where: { id }, include: { comment: true } });
      if (!report) throw new ApiError(404, "REPORT_NOT_FOUND", "Report not found.");
      const nextStatus = body.action === "HIDE" ? "ACTIONED" : "DISMISSED";
      const claimed = await tx.commentReport.updateMany({ where: { id, status: "PENDING" }, data: { status: nextStatus, resolvedById: user.id, resolution: body.note, resolvedAt: new Date() } });
      if (claimed.count !== 1) throw new ApiError(409, "REPORT_ALREADY_REVIEWED", "This report has already been reviewed.");
      if (body.action === "HIDE" && report.comment.status === "VISIBLE") {
        const hidden = await tx.comment.updateMany({ where: { id: report.commentId, status: "VISIBLE" }, data: { status: "HIDDEN" } });
        if (hidden.count === 1) {
          await tx.market.updateMany({ where: { id: report.comment.marketId, commentCount: { gt: 0 } }, data: { commentCount: { decrement: 1 } } });
          await tx.notification.create({ data: { userId: report.comment.userId, type: "COMMENT_MODERATED", title: "A comment was hidden", body: body.note, href: null } });
        }
      }
      await tx.auditLog.create({ data: { actorUserId: user.id, action: `COMMENT_REPORT_${body.action}`, entityType: "COMMENT_REPORT", entityId: id, metadata: JSON.stringify({ commentId: report.commentId, note: body.note }) } });
      return tx.commentReport.findUniqueOrThrow({ where: { id } });
    });
    return jsonResponse({ report: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
