import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";

import { apiErrorResponse, consumeRateLimit, jsonResponse, prisma } from "@/lib/market-service";
import { getPublicOrderBook, parseOrderBookQuery } from "@/lib/order-service";
import { requestRateLimitKey } from "@/lib/security";
import { jsonStringify } from "@/lib/serializers";

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
      // Time-based expiry can change visible depth before the worker advances
      // bookSequence, so the validator must identify the actual representation.
      headers: { ETag: `"book-${createHash("sha256").update(jsonStringify(book)).digest("hex")}"` },
    }));
  } catch (error) {
    return noStore(apiErrorResponse(error));
  }
}
