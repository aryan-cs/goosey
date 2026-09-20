import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";
import { ChainCommandNotFoundError, PrismaChainCommandStore } from "@/lib/solana/chain-command-store";
import { dispatchManagedOrderCommand } from "@/lib/solana/managed-order-dispatcher";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/) }).strict();
const redispatchableOrderStatuses = new Set(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED_RETRYABLE"]);

function privateNoStore(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const { id } = paramsSchema.parse(await context.params);
    const store = new PrismaChainCommandStore(db);
    const command = await store.load(id);
    // Return the same response for missing and foreign commands to prevent ID
    // enumeration across accounts.
    if (command.identity.actorId !== user.id) {
      throw new ApiError(404, "COMMAND_NOT_FOUND", "Order status not found.");
    }
    const status = await store.publicStatus(id);
    if (command.identity.operation === "PLACE_ORDER" && redispatchableOrderStatuses.has(status.status)) {
      // Status polling is also the crash-recovery trigger. Fenced dispatch and
      // append-only wire reconciliation make concurrent polls harmless.
      after(async () => {
        await dispatchManagedOrderCommand(id).catch(() => {
          console.error("Managed order recovery dispatch failed; the durable command remains recoverable.", id);
        });
      });
    }
    return privateNoStore(jsonResponse(status));
  } catch (error) {
    if (error instanceof ChainCommandNotFoundError) {
      return privateNoStore(apiErrorResponse(new ApiError(404, "COMMAND_NOT_FOUND", "Order status not found.")));
    }
    return privateNoStore(apiErrorResponse(error));
  }
}
