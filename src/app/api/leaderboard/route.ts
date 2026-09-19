import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonResponse } from "@/lib/market-service";
import { getLeaderboardRows } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    period: z.literal("hackathon").default("hackathon"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const rows = await getLeaderboardRows(query.limit);
    return jsonResponse(
      { period: query.period, generatedAt: new Date(), rows },
      { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
