import { NextRequest, NextResponse } from "next/server";
import { apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { listPublicEvents, parseEventListQuery } from "@/lib/public-events";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const params = request.nextUrl.searchParams;
    const input = Object.fromEntries([...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }));
    const result = await listPublicEvents(prisma, parseEventListQuery(input));
    return jsonResponse(result, { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
