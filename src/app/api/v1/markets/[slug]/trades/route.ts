import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { listPublicTrades, parsePublicTradesQuery } from "@/lib/fill-service";
import { apiErrorResponse, jsonResponse } from "@/lib/market-service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ slug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const query = parsePublicTradesQuery(request.nextUrl.searchParams, slug);
    const response = jsonResponse(await listPublicTrades({ marketSlug: slug, ...query }));
    response.headers.set("Cache-Control", "public, max-age=0, s-maxage=1, stale-while-revalidate=4");
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
