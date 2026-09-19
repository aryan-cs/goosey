import { NextRequest } from "next/server";
import { requireDatabaseStartup } from "@/lib/db";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { requestRateLimitKey } from "@/lib/security";
import { parseCatalogMarketId, readSolanaCatalogEntry } from "@/lib/solana/catalog-entry";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest, context: { params: Promise<{ marketId: string }> }) {
  try {
    if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") {
      throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Public chain catalog is not enabled.");
    }
    if (request.nextUrl.searchParams.size !== 0) {
      throw new ApiError(400, "INVALID_QUERY", "This lookup accepts no query parameters.");
    }
    const { marketId } = await context.params;
    parseCatalogMarketId(marketId);
    let deployment;
    try { deployment = resolveSolanaRuntime(process.env); }
    catch { throw new ApiError(503, "CHAIN_CATALOG_UNAVAILABLE", "Public chain catalog is not configured."); }
    await requireDatabaseStartup();
    await consumeRateLimit(prisma, requestRateLimitKey(request, "solana:catalog:entry"), 60, 60_000);
    const item = await readSolanaCatalogEntry(deployment, marketId);
    if (!item) throw new ApiError(404, "CATALOG_ENTRY_NOT_FOUND", "Published chain catalog entry not found.");
    return jsonResponse({ item }, { headers });
  } catch (error) {
    const response = apiErrorResponse(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
