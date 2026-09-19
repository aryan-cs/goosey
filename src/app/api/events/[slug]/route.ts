import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, jsonResponse, prisma } from "@/lib/market-service";
import { getPublicEvent } from "@/lib/public-events";

const paramsSchema = z.object({ slug: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).strict();

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const event = await getPublicEvent(prisma, slug);
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found.");
    return jsonResponse({ event }, { headers: { "Cache-Control": "public, max-age=5, stale-while-revalidate=20" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
