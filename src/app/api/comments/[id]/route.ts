import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import {
  ApiError,
  apiErrorResponse,
  consumeRateLimit,
  jsonResponse,
  prisma,
  requireUser,
} from "@/lib/market-service";
import { serializeComment } from "@/lib/serializers";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const updateSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(800)
      .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)),
  })
  .strict();

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const { id } = paramsSchema.parse(await context.params);
    const body = updateSchema.parse(await readJsonObject(request));
    await consumeRateLimit(prisma, `comment-edit:${user.id}`, 10, 60_000);
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.comment.updateMany({
        where: { id, userId: user.id, status: "VISIBLE" },
        data: { body: body.body },
      });
      if (changed.count !== 1) {
        const exists = await tx.comment.findUnique({ where: { id }, select: { userId: true } });
        if (!exists) throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
        throw new ApiError(403, "COMMENT_NOT_OWNED", "You cannot edit this comment.");
      }
      return tx.comment.findUniqueOrThrow({
        where: { id },
        include: { user: { select: { id: true, username: true, displayName: true } } },
      });
    });
    return jsonResponse({ comment: serializeComment(updated) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const { id } = paramsSchema.parse(await context.params);
    await prisma.$transaction(async (tx) => {
      const comment = await tx.comment.findUnique({
        where: { id },
        select: { userId: true, marketId: true, status: true },
      });
      if (!comment) throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
      if (comment.userId !== user.id) {
        throw new ApiError(403, "COMMENT_NOT_OWNED", "You cannot delete this comment.");
      }
      if (comment.status === "DELETED") return;
      const changed = await tx.comment.updateMany({
        where: { id, userId: user.id, status: comment.status },
        data: { status: "DELETED", body: "[deleted]" },
      });
      if (changed.count !== 1) {
        throw new ApiError(409, "COMMENT_CHANGED", "The comment changed concurrently. Refresh before retrying.");
      }
      if (comment.status === "VISIBLE") {
        await tx.market.updateMany({
          where: { id: comment.marketId, commentCount: { gt: 0 } },
          data: { commentCount: { decrement: 1 } },
        });
      }
    });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
