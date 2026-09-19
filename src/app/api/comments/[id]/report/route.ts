import { runAuthenticatedMutation } from "@/lib/mutation-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { submitCommentReportInTransaction } from "@/lib/comment-reporting";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const reportSchema = z.object({ reason: z.enum(["HARASSMENT", "PRIVATE_INFORMATION", "SPAM", "MANIPULATION", "OTHER"]), details: z.string().trim().max(500).default("") }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const { id } = paramsSchema.parse(await context.params);
    const body = reportSchema.parse(await readJsonObject(request));
    await consumeRateLimit(prisma, `comment-report:${user.id}`, 10, 86_400_000);
    const report = await runAuthenticatedMutation(request, user.id, (tx) =>
      submitCommentReportInTransaction(tx, {
        commentId: id,
        reporterId: user.id,
        reason: body.reason,
        details: body.details,
      }),
    );
    return jsonResponse({ report }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
