import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { acceptManagedResolutionCommand } from "@/lib/solana/managed-resolution-service";

export const runtime = "nodejs";
export const maxDuration = 60;

const paramsSchema = z.object({ slug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

/** Claims only the authenticated user's canonical managed seat. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const idempotencyKey = parseIdempotencyKey(request);
    const { slug } = paramsSchema.parse(await context.params);
    const market = await db.market.findUnique({ where: { slug }, select: { executionBackend: true } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (market.executionBackend !== "SOLANA") {
      throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This market does not use managed on-chain claims.");
    }
    const result = await acceptManagedResolutionCommand({
      actorUserId: user.id,
      marketSlug: slug,
      idempotencyKey,
      intent: { operation: "CLAIM_RESOLUTION" },
    });
    after(async () => {
      await dispatchManagedResolutionCommand(result.command.id).catch(() => {
        console.error("Managed resolution claim dispatch failed; the durable command remains recoverable.", result.command.id);
      });
    });
    return privateNoStore(jsonResponse({ ...result, statusUrl: `/api/v1/commands/${result.command.id}` }, { status: 202 }));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}
