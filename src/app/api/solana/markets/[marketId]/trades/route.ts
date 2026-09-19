import { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { requestRateLimitKey } from "@/lib/security";
import { parseTradeTapeMarketId, parseTradeTapeQuery, readSolanaTradeTape } from "@/lib/solana/trade-tape";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest, context: { params: Promise<{ marketId: string }> }) {
  try {
    const marketId = parseTradeTapeMarketId((await context.params).marketId);
    const searchParams = request.nextUrl.searchParams;
    for (const key of searchParams.keys()) {
      if (searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_QUERY", "Chain trade parameters cannot be repeated.");
      }
    }
    const query = parseTradeTapeQuery(Object.fromEntries(searchParams));
    let deployment;
    try { deployment = resolveSolanaRuntime(process.env); }
    catch { throw new ApiError(503, "SOLANA_DISABLED", "Chain trade history is not configured."); }
    await consumeRateLimit(prisma, requestRateLimitKey(request, "solana:market:trades"), 60, 60_000);
    return jsonResponse(await readSolanaTradeTape(deployment, marketId, query), { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
