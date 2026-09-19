import { NextRequest, NextResponse } from "next/server";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { loadTradeHistory, parseTradeHistoryCursor } from "@/lib/trade-history";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";

function privateResponse(response: NextResponse) {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireUser(request);
    const query = request.nextUrl.searchParams;
    for (const key of query.keys()) {
      if (!["cursor", "limit"].includes(key) || query.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_REQUEST", "Unknown or repeated history parameter.");
      }
    }
    const rawLimit = query.get("limit") ?? "30";
    if (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) {
      throw new ApiError(400, "INVALID_REQUEST", "History limit must be between 1 and 100.");
    }
    const cursor = parseTradeHistoryCursor(query.get("cursor") ?? undefined);
    const history = await runSerializableTransaction(prisma, (tx) => loadTradeHistory(tx, user.id, { limit: Number(rawLimit), cursor }));
    return privateResponse(jsonResponse(history));
  } catch (error) {
    return privateResponse(apiErrorResponse(error));
  }
}
