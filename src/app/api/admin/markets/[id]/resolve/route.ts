import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, createResolutionProposal, resolutionSchema } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { apiErrorResponse, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { acceptManagedResolutionProposal } from "@/lib/solana/managed-resolution-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const idempotencyKey = parseIdempotencyKey(request);
    const { id } = paramsSchema.parse(await context.params);
    const resolution = resolutionSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const backend = await prisma.market.findUnique({
      where: { id },
      select: { executionBackend: true },
    });
    const result = backend?.executionBackend === "SOLANA"
      ? await acceptManagedResolutionProposal({ actorUserId: user.id, marketId: id, idempotencyKey, resolution })
      : await createResolutionProposal({ actorUserId: user.id, marketId: id, idempotencyKey, resolution });
    if ("command" in result) {
      after(async () => {
        await dispatchManagedResolutionCommand(result.command.id).catch(() => {
          console.error("Managed resolution proposal dispatch failed; the durable command remains recoverable.", result.command.id);
        });
      });
      return jsonResponse({ ...result, statusUrl: `/api/v1/commands/${result.command.id}` },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    return jsonResponse(result, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
