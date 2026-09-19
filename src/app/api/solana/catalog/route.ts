import { NextRequest } from "next/server";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { requestRateLimitKey } from "@/lib/security";
import { parseSolanaCatalogQuery, readSolanaCatalog } from "@/lib/solana/catalog-read";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

/** Public metadata discovery only. OPEN means listed in this catalog, not that
 * the on-chain market is currently accepting orders. Chain state is read from
 * the separately pinned finalized-market endpoint before transaction signing.
 */
export async function GET(request: NextRequest) {
  try {
    if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") {
      throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Public chain catalog is not enabled.");
    }
    let deployment;
    try { deployment = resolveSolanaRuntime(process.env); }
    catch { throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Public chain catalog is not configured."); }
    const searchParams = request.nextUrl.searchParams;
    for (const key of searchParams.keys()) {
      if (searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_QUERY", "Chain catalog parameters cannot be repeated.");
      }
    }
    const query = parseSolanaCatalogQuery(Object.fromEntries(searchParams));
    await consumeRateLimit(prisma, requestRateLimitKey(request, "solana:catalog:read"), 60, 60_000);
    return jsonResponse(await readSolanaCatalog(deployment, query), { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
