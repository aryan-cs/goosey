import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonResponse } from "@/lib/market-service";
import { searchLeaderboardPlayers } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(20).default(8),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const players = await searchLeaderboardPlayers(query.q, query.limit);
    return jsonResponse({ query: query.q, players }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
