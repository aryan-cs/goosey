import { NextRequest } from "next/server";

import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { requestRateLimitKey } from "@/lib/security";
import { readPublicSolanaIndexerStatus } from "@/lib/solana/indexer-health";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Operational metadata only: no RPC endpoint, signatures, provider errors,
 * instance identifiers, or persisted error types cross this boundary. */
export async function GET(request: NextRequest) {
  try {
    if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") {
      throw new ApiError(503, "CHAIN_INDEXER_UNAVAILABLE", "Public chain indexer status is not enabled.");
    }
    let deployment;
    try { deployment = resolveSolanaRuntime(process.env); }
    catch { throw new ApiError(503, "CHAIN_INDEXER_UNAVAILABLE", "Public chain indexer status is not configured."); }
    if ([...request.nextUrl.searchParams.keys()].length !== 0) {
      throw new ApiError(400, "INVALID_QUERY", "Chain indexer status does not accept query parameters.");
    }
    await consumeRateLimit(prisma, requestRateLimitKey(request, "solana:indexer:status"), 60, 60_000);
    return jsonResponse(await readPublicSolanaIndexerStatus(deployment), { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
