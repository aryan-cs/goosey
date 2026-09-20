import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";
import { ChainCommandNotFoundError, PrismaChainCommandStore } from "@/lib/solana/chain-command-store";
import { dispatchManagedAmendmentCommand } from "@/lib/solana/managed-amendment-dispatcher";
import { dispatchManagedCancellationCommand } from "@/lib/solana/managed-cancellation-dispatcher";
import { dispatchManagedMarketProvisioningCommand } from "@/lib/solana/managed-market-provisioning-dispatcher";
import { dispatchManagedMarketBookCommand } from "@/lib/solana/managed-market-book-dispatcher";
import { dispatchManagedOrderCommand } from "@/lib/solana/managed-order-dispatcher";
import { dispatchManagedResolutionCommand } from "@/lib/solana/managed-resolution-dispatcher";
import { dispatchManagedFeatherTransferCommand } from "@/lib/solana/managed-transfer-dispatcher";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/) }).strict();
const redispatchableOrderStatuses = new Set(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED_RETRYABLE"]);
const redispatchableCancellationStatuses = new Set([...redispatchableOrderStatuses, "UNKNOWN"]);
const redispatchableProvisioningStatuses = new Set([...redispatchableCancellationStatuses, "FINALIZED"]);
const managedAdminResolutionOperations = new Set([
  "CLOSE_RESOLUTION",
  "PROPOSE_RESOLUTION",
  "APPROVE_RESOLUTION",
  "FINALIZE_RESOLUTION",
]);
const recoveryDispatchers = {
  APPROVE_RESOLUTION: dispatchManagedResolutionCommand,
  CANCEL_ORDER: dispatchManagedCancellationCommand,
  CLAIM_RESOLUTION: dispatchManagedResolutionCommand,
  CLOSE_RESOLUTION: dispatchManagedResolutionCommand,
  FINALIZE_RESOLUTION: dispatchManagedResolutionCommand,
  PLACE_ORDER: dispatchManagedOrderCommand,
  PROPOSE_RESOLUTION: dispatchManagedResolutionCommand,
  PROVISION_MARKET: dispatchManagedMarketProvisioningCommand,
  PROVISION_MARKET_BOOK: dispatchManagedMarketBookCommand,
  REPLACE_ORDER: dispatchManagedAmendmentCommand,
  TRANSFER_FEATHERS: dispatchManagedFeatherTransferCommand,
} as const;

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
    if ((["PROVISION_MARKET", "PROVISION_MARKET_BOOK"].includes(command.identity.operation)
      || managedAdminResolutionOperations.has(command.identity.operation)) && user.role !== "ADMIN") {
      throw new ApiError(404, "COMMAND_NOT_FOUND", "Order status not found.");
    }
    const status = await store.publicStatus(id);
    const dispatch = recoveryDispatchers[command.identity.operation as keyof typeof recoveryDispatchers];
    const redispatchableStatuses = command.identity.operation === "PROVISION_MARKET"
      || command.identity.operation === "PROVISION_MARKET_BOOK"
      ? redispatchableProvisioningStatuses
      : command.identity.operation === "CANCEL_ORDER"
      || command.identity.operation === "REPLACE_ORDER"
      || command.identity.operation === "TRANSFER_FEATHERS"
      || command.identity.operation === "CLAIM_RESOLUTION"
      || managedAdminResolutionOperations.has(command.identity.operation)
      ? redispatchableCancellationStatuses : redispatchableOrderStatuses;
    if (dispatch && redispatchableStatuses.has(status.status)) {
      // Status polling is also the crash-recovery trigger. Fenced dispatch and
      // append-only wire reconciliation make concurrent polls harmless.
      after(async () => {
        await dispatch(id).catch(() => {
          console.error("Managed command recovery dispatch failed; the durable command remains recoverable.", id);
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
