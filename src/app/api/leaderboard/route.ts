import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonResponse } from "@/lib/market-service";
import { getLeaderboardPage } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

const querySchema = z
  .object({
    period: z.literal("hackathon").default("hackathon"),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const result = await getLeaderboardPage(query.page, query.limit);
    return jsonResponse(
      { period: query.period, generatedAt: new Date(), ...result },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
