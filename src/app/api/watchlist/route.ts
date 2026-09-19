import { runAuthenticatedMutation } from "@/lib/mutation-session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import { readJsonObject } from "@/lib/http";

const bodySchema = z.object({ marketId: z.string().cuid() }).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const items = await prisma.watchlistEntry.findMany({
      where: { userId: user.id, ...(user.role === "ADMIN" ? {} : { market: { status: { not: "DRAFT" } } }) },
      orderBy: { createdAt: "desc" },
      select: { marketId: true, createdAt: true, market: { select: { id: true, slug: true, title: true, status: true } } },
    });
    return jsonResponse({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    await consumeRateLimit(prisma, `watchlist:${user.id}`, 40, 60_000);
    const { marketId } = bodySchema.parse(await readJsonObject(request));
    const item = await runAuthenticatedMutation(request, user.id, async (tx, actor) => {
      const market = await tx.market.findFirst({ where: { id: marketId, ...(actor.role === "ADMIN" ? {} : { status: { not: "DRAFT" } }) }, select: { id: true } });
      if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      return tx.watchlistEntry.upsert({
        where: { userId_marketId: { userId: user.id, marketId } },
        create: { userId: user.id, marketId }, update: {},
      });
    });
    return jsonResponse({ saved: true, item }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const { marketId } = bodySchema.parse(await readJsonObject(request));
    await runAuthenticatedMutation(request, user.id, (tx) => tx.watchlistEntry.deleteMany({ where: { userId: user.id, marketId } }));
    return jsonResponse({ saved: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
