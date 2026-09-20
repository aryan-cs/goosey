import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError, apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";
import { ChainCommandNotFoundError, PrismaChainCommandStore } from "@/lib/solana/chain-command-store";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().min(8).max(191).regex(/^[A-Za-z0-9._:-]+$/) }).strict();

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
    return privateNoStore(jsonResponse(await store.publicStatus(id)));
  } catch (error) {
    if (error instanceof ChainCommandNotFoundError) {
      return privateNoStore(apiErrorResponse(new ApiError(404, "COMMAND_NOT_FOUND", "Order status not found.")));
    }
    return privateNoStore(apiErrorResponse(error));
  }
}
