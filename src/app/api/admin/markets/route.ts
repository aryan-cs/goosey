import { after, NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http";
import { createMarketSchema, assertAdmin } from "@/lib/admin-service";
import { apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";
import { dispatchManagedMarketProvisioningCommand } from "@/lib/solana/managed-market-provisioning-dispatcher";
import { acceptManagedMarketProvisioning } from "@/lib/solana/managed-market-provisioning-service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    const idempotencyKey = parseIdempotencyKey(request);
    const market = createMarketSchema.parse(await readJsonObject(request));
    assertAdmin(await requireUser(request, true));
    const result = await acceptManagedMarketProvisioning({ actorUserId: user.id, idempotencyKey, market });
    if (!["PROJECTED", "FAILED_TERMINAL", "UNKNOWN"].includes(result.command.status)) {
      after(async () => {
        await dispatchManagedMarketProvisioningCommand(result.command.id).catch(() => {
          // Exact intent and any signed bytes are durable. A later dispatcher
          // may resume without manufacturing a database financial fallback.
        });
      });
    }
    return jsonResponse(result, { status: result.replayed ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
