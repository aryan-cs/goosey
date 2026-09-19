import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./market-service";
import { submitCommentReportInTransaction } from "./comment-reporting";

function transactionFixture(input: {
  commentUpdatedAt: Date;
  reportStatus?: string;
  resolvedAt?: Date | null;
}) {
  const report = input.reportStatus
    ? {
        id: "report_1",
        commentId: "comment_1",
        reporterId: "reporter_1",
        reason: "SPAM",
        details: "old evidence",
        status: input.reportStatus,
        resolvedById: input.reportStatus === "PENDING" ? null : "admin_1",
        resolution: input.reportStatus === "PENDING" ? null : "reviewed",
        createdAt: new Date("2029-01-01T00:00:00.000Z"),
        resolvedAt: input.resolvedAt ?? null,
      }
    : null;
  const updated = report ? { ...report, status: "PENDING" } : null;
  const tx = {
    comment: {
      findUnique: vi.fn().mockResolvedValue({
        userId: "author_1",
        status: "VISIBLE",
        updatedAt: input.commentUpdatedAt,
      }),
    },
    commentReport: {
      findUnique: vi.fn().mockResolvedValue(report),
      create: vi.fn().mockResolvedValue({ id: "created_report" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(updated),
    },
  };
  return tx;
}

const request = {
  commentId: "comment_1",
  reporterId: "reporter_1",
  reason: "HARASSMENT" as const,
  details: "new evidence",
};

describe("comment re-report moderation integrity", () => {
  it("reopens a dismissed report when the author edited the comment afterward", async () => {
    const resolvedAt = new Date("2029-01-02T00:00:00.000Z");
    const tx = transactionFixture({
      reportStatus: "DISMISSED",
      resolvedAt,
      commentUpdatedAt: new Date("2029-01-03T00:00:00.000Z"),
    });

    await submitCommentReportInTransaction(tx as never, request);

    expect(tx.commentReport.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "PENDING",
        resolvedById: null,
        resolution: null,
        resolvedAt: null,
      }),
    }));
  });

  it("does not repeatedly reopen an unchanged reviewed comment", async () => {
    const resolvedAt = new Date("2029-01-03T00:00:00.000Z");
    const tx = transactionFixture({
      reportStatus: "DISMISSED",
      resolvedAt,
      commentUpdatedAt: new Date("2029-01-02T00:00:00.000Z"),
    });

    await expect(submitCommentReportInTransaction(tx as never, request)).rejects.toMatchObject<Partial<ApiError>>({
      status: 409,
      code: "REPORT_ALREADY_REVIEWED",
    });
    expect(tx.commentReport.updateMany).not.toHaveBeenCalled();
  });

  it("updates the evidence on a still-pending report without duplicating it", async () => {
    const tx = transactionFixture({
      reportStatus: "PENDING",
      commentUpdatedAt: new Date("2029-01-02T00:00:00.000Z"),
    });

    await submitCommentReportInTransaction(tx as never, request);

    expect(tx.commentReport.create).not.toHaveBeenCalled();
    expect(tx.commentReport.updateMany).toHaveBeenCalledTimes(1);
  });
});
