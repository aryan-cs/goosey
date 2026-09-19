import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { getPublicOrderBook, parseOrderBookQuery } from "@/lib/order-service";
import { requestRateLimitKey } from "@/lib/security";

export const dynamic = "force-dynamic";

const paramsSchema = z
  .object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(160) })
  .strict();

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  return response;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const { depth } = parseOrderBookQuery(request.nextUrl.searchParams);
    await consumeRateLimit(prisma, requestRateLimitKey(request, "orderbook-read"), 240, 60_000);
    const book = await getPublicOrderBook(slug, depth);
    return noStore(jsonResponse(book, {
      headers: { ETag: `"book-${book.sequence.toString()}"` },
    }));
  } catch (error) {
    return noStore(apiErrorResponse(error));
  }
}
