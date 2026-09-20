import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { approveResolutionProposal, assertAdmin, rejectResolutionProposal } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { verifyPassword } from "@/lib/auth";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { acceptManagedResolutionApproval } from "@/lib/solana/managed-resolution-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const bodySchema = z.object({ action: z.enum(["APPROVE", "REJECT"]), note: z.string().trim().max(1_000).default(""), password: z.string().max(1_000).optional() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    const body = bodySchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    if (body.action === "APPROVE") {
      await consumeRateLimit(prisma, `admin-resolution-step-up:${user.id}`, 5, 15 * 60_000);
      if (!body.password) throw new ApiError(403, "STEP_UP_REQUIRED", "Re-enter your administrator password to approve settlement.");
      const credentials = await prisma.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } });
      if (!credentials || !(await verifyPassword(body.password, credentials.passwordHash))) throw new ApiError(403, "STEP_UP_FAILED", "Administrator password verification failed.");
      const idempotencyKey = parseIdempotencyKey(request);
      const proposal = await prisma.marketResolutionProposal.findUnique({
        where: { id },
        select: { market: { select: { executionBackend: true } } },
      });
      if (proposal?.market.executionBackend === "SOLANA") {
        const result = await acceptManagedResolutionApproval({ actorUserId: user.id, proposalId: id, idempotencyKey });
        after(async () => {
          await dispatchManagedResolutionCommand(result.command.id).catch(() => {
            console.error("Managed resolution approval dispatch failed; the durable command remains recoverable.", result.command.id);
          });
        });
        return jsonResponse({ ...result, statusUrl: `/api/v1/commands/${result.command.id}` },
          { status: 202, headers: { "Cache-Control": "no-store" } });
      }
      const result = await approveResolutionProposal({ actorUserId: user.id, proposalId: id, idempotencyKey });
      return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
    }
    const note = z.string().trim().min(3).max(1_000).parse(body.note);
    const result = await rejectResolutionProposal({ actorUserId: user.id, proposalId: id, note });
    return jsonResponse(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
