import { NextRequest } from "next/server";

import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { requestRateLimitKey } from "@/lib/security";
import { parseSolanaLeaderboardQuery, readSolanaLeaderboard } from "@/lib/solana/leaderboard";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  try {
    if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") {
      throw new ApiError(503, "CHAIN_LEADERBOARD_UNAVAILABLE", "Public chain leaderboard is not enabled.");
    }
    let deployment;
    try { deployment = resolveSolanaRuntime(process.env); }
    catch { throw new ApiError(503, "CHAIN_LEADERBOARD_UNAVAILABLE", "Public chain leaderboard is not configured."); }
    const searchParams = request.nextUrl.searchParams;
    for (const key of searchParams.keys()) {
      if (searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_QUERY", "Chain leaderboard parameters cannot be repeated.");
      }
    }
    const query = parseSolanaLeaderboardQuery(Object.fromEntries(searchParams));
    await consumeRateLimit(prisma, requestRateLimitKey(request, "solana:leaderboard:read"), 60, 60_000);
    return jsonResponse(await readSolanaLeaderboard(deployment, query), { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
