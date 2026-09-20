import { after, NextRequest, NextResponse } from "next/server";

import { readJsonObject } from "@/lib/http";
import {
  apiErrorResponse,
  consumeRateLimit,
  jsonResponse,
  parseIdempotencyKey,
  prisma,
  requireUser,
} from "@/lib/market-service";
import { dispatchManagedFeatherTransferCommand } from "@/lib/solana/managed-transfer-dispatcher";
import { acceptManagedFeatherTransfer, managedTransferRequestSchema } from "@/lib/solana/managed-transfer-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const idempotencyKey = parseIdempotencyKey(request);
    const body = managedTransferRequestSchema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    await consumeRateLimit(prisma, `managed-feather-transfer:${user.id}`, 20, 60_000);
    const result = await acceptManagedFeatherTransfer({
      senderUserId: user.id,
      idempotencyKey,
      request: body,
    });
    after(async () => {
      await dispatchManagedFeatherTransferCommand(result.command.id).catch(() => {
        console.error("Managed feather transfer dispatch failed; the durable command remains recoverable.", result.command.id);
      });
    });
    return privateNoStore(jsonResponse(result, { status: 202 }));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}
