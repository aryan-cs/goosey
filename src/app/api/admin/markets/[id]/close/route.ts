import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertAdmin, lifecycleReasonSchema, transitionAdminMarket } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { acceptManagedResolutionCommand } from "@/lib/solana/managed-resolution-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().cuid() }).strict();

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const { id } = paramsSchema.parse(await context.params);
    const { reason, expectedVersion } = lifecycleReasonSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const market = await prisma.market.findUnique({ where: { id }, select: { slug: true, executionBackend: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (market.executionBackend === "SOLANA") {
      // The existing admin console predates command IDs. Its market version is
      // a stable retry boundary; API clients may supply a stronger explicit key.
      const idempotencyKey = request.headers.has("idempotency-key")
        ? parseIdempotencyKey(request)
        : `admin-close-v1:${id}:${expectedVersion}`;
      const result = await acceptManagedResolutionCommand({ actorUserId: user.id, marketSlug: market.slug,
        idempotencyKey, intent: { operation: "CLOSE_RESOLUTION" } });
      after(async () => {
        await dispatchManagedResolutionCommand(result.command.id).catch(() => {
          console.error("Managed resolution close dispatch failed; the durable command remains recoverable.", result.command.id);
        });
      });
      return jsonResponse({ ...result, statusUrl: `/api/v1/commands/${result.command.id}` },
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    return jsonResponse(await transitionAdminMarket({ actorUserId: user.id, marketId: id, action: "CLOSE", reason, expectedVersion }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
