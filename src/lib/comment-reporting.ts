import type { Prisma } from "@prisma/client";

import { ApiError } from "@/lib/market-service";

export type CommentReportReason =
  | "HARASSMENT"
  | "PRIVATE_INFORMATION"
  | "SPAM"
  | "MANIPULATION"
  | "OTHER";

export async function submitCommentReportInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    commentId: string;
    reporterId: string;
    reason: CommentReportReason;
    details: string;
  },
) {
  const comment = await tx.comment.findUnique({
    where: { id: input.commentId },
    select: { userId: true, status: true, updatedAt: true, market: { select: { status: true } } },
  });
  if (!comment || comment.status !== "VISIBLE" || comment.market.status === "DRAFT") {
    throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
  }
  if (comment.userId === input.reporterId) {
    throw new ApiError(422, "CANNOT_REPORT_OWN_COMMENT", "You cannot report your own comment.");
  }

  const existing = await tx.commentReport.findUnique({
    where: {
      commentId_reporterId: {
        commentId: input.commentId,
        reporterId: input.reporterId,
      },
    },
  });
  if (!existing) {
    return tx.commentReport.create({
      data: {
        commentId: input.commentId,
        reporterId: input.reporterId,
        reason: input.reason,
        details: input.details,
      },
    });
  }

  if (
    existing.status !== "PENDING" &&
    existing.resolvedAt &&
    comment.updatedAt <= existing.resolvedAt
  ) {
    throw new ApiError(
      409,
      "REPORT_ALREADY_REVIEWED",
      "This version of the comment has already been reviewed.",
    );
  }

  const reopened = await tx.commentReport.updateMany({
    where: {
      id: existing.id,
      status: existing.status,
      resolvedAt: existing.resolvedAt,
    },
    data: {
      reason: input.reason,
      details: input.details,
      status: "PENDING",
      resolvedById: null,
      resolution: null,
      resolvedAt: null,
    },
  });
  if (reopened.count !== 1) {
    throw new ApiError(409, "REPORT_CHANGED", "The report changed concurrently. Retry the request.");
  }
  return tx.commentReport.findUniqueOrThrow({ where: { id: existing.id } });
}
