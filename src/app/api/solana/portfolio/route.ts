import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/market-service";
import { jsonError } from "@/lib/http";
import { enforceRateLimit, identityRateLimitKey, requestRateLimitKey } from "@/lib/security";
import { parsePortfolioQuery, readSolanaPortfolio } from "@/lib/solana/portfolio";
import { privateResponse, walletAuthentication, walletConfiguration, walletError } from "../wallet/_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const { userId } = await walletAuthentication(request, false);
    await enforceRateLimit(requestRateLimitKey(request, "solana:portfolio:ip"), 60, 60_000);
    await enforceRateLimit(identityRateLimitKey("solana:portfolio:user", userId), 20, 60_000);
    if (process.env.GOOSEY_SOLANA_CATALOG_ENABLED !== "true") throw new ApiError(503, "PORTFOLIO_UNAVAILABLE", "Portfolio disabled.");
    const { runtime: deployment } = walletConfiguration();
    const params = request.nextUrl.searchParams;
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ApiError(400, "INVALID_QUERY", "Repeated query.");
    const query = parsePortfolioQuery(Object.fromEntries(params));
    const result = await readSolanaPortfolio({ userId, runtime: deployment, query, signal: request.signal });
    return privateResponse(NextResponse.json(result));
  } catch (error) {
    if (error instanceof ApiError && ["INVALID_QUERY", "INVALID_CURSOR", "PORTFOLIO_UNAVAILABLE"].includes(error.code)) {
      return privateResponse(jsonError(error.code === "PORTFOLIO_UNAVAILABLE" ? 503 : 400, error.code,
        error.code === "PORTFOLIO_UNAVAILABLE" ? "On-chain portfolio is unavailable." : "Invalid portfolio pagination."));
    }
    return walletError(error);
  }
}
