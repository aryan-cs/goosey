import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { chronologicalPriceHistory } from "@/lib/price-history";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { decodeCursor, encodeCursor, jsonSafe } from "@/lib/serializers";
import {
  createUnifiedMarketReadRepository,
  type UnifiedMarket,
  type UnifiedSolanaMarket,
} from "@/lib/unified-market-repository";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOID"]).default("OPEN"),
  category: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["trending", "volume", "newest", "closing"]).default("trending"),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  cursor: z.string().max(500).optional(),
}).strict();

const markets = createUnifiedMarketReadRepository({ client: prisma });

function databaseListItem(market: Extract<UnifiedMarket, { executionBackend: "DATABASE" }>) {
  const row = market.financial.market;
  const mark = market.financial.mark;
  const { priceHistory, orderFills } = row;
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    shortTitle: row.shortTitle,
    description: row.description,
    category: row.category,
    status: row.status,
    executionBackend: row.executionBackend,
    pricingModel: row.pricingModel,
    acceptingOrders: row.acceptingOrders,
    resolution: row.resolution,
    featured: row.featured,
    color: row.color,
    icon: row.icon,
    closesAt: row.closesAt,
    resolvesAt: row.resolvesAt,
    yesShares: row.yesShares,
    noShares: row.noShares,
    liquidityParameter: row.liquidityParameter,
    payoutMilli: row.payoutMilli,
    volumeMilli: row.volumeMilli,
    traderCount: row.traderCount,
    commentCount: row.commentCount,
    version: row.version,
    updatedAt: row.updatedAt,
    probabilityYesBps: mark.probabilityYesBps,
    probabilitySource: mark.source,
    probabilityStale: mark.stale,
    priceHistory: row.pricingModel === "ORDER_BOOK"
      ? orderFills.slice().reverse().map(fill => ({
          timestamp: fill.createdAt,
          probabilityYesBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, row.payoutMilli)),
        }))
      : mark.probabilityYesBps === null
        ? []
        : chronologicalPriceHistory(
            priceHistory.map(point => ({ timestamp: point.createdAt, probabilityYesBps: point.yesProbabilityBps })),
            mark.probabilityYesBps,
            row.updatedAt,
          ),
  };
}

function publicStatus(status: UnifiedSolanaMarket["financial"]["status"]) {
  return status === "RESOLVING" ? "CLOSED" : status;
}

function solanaListItem(market: UnifiedSolanaMarket) {
  const { editorial, financial } = market;
  return {
    ...editorial,
    status: publicStatus(financial.status),
    acceptingOrders: financial.acceptingOrders,
    resolution: financial.resolution,
    pricingModel: "ORDER_BOOK",
    closesAt: financial.closesAt,
    resolvesAt: financial.resolvesAt,
    payoutMilli: financial.payoutMilli,
    feeBps: financial.feeBps,
    traderCount: financial.traderCount,
    probabilityYesBps: financial.probabilityYesBps,
    probabilitySource: financial.probabilitySource,
    probabilityStale: false,
    priceHistory: [],
    orderBook: { bids: financial.bids, asks: financial.asks },
    recentTrades: financial.recentTrades.map(trade => ({
      id: `${trade.signature}:${trade.logIndex}`,
      quantity: trade.quantity,
      yesPriceMilli: trade.yesPriceMilli,
    })),
    recentTradeWindowComplete: financial.recentTradeWindowComplete,
  };
}

function sortValue(market: UnifiedMarket, sort: "trending" | "volume") {
  if (market.executionBackend === "SOLANA") {
    return sort === "trending" ? BigInt(market.financial.traderCount) : 0n;
  }
  return sort === "trending" ? BigInt(market.financial.market.traderCount) : market.financial.market.volumeMilli;
}

function routeSort(items: readonly UnifiedMarket[], sort: "trending" | "volume" | "newest" | "closing") {
  if (sort === "newest" || sort === "closing") return [...items];
  return [...items].sort((left, right) => {
    if (sort === "trending" && left.editorial.featured !== right.editorial.featured) {
      return left.editorial.featured ? -1 : 1;
    }
    const leftValue = sortValue(left, sort);
    const rightValue = sortValue(right, sort);
    if (leftValue !== rightValue) return leftValue > rightValue ? -1 : 1;
    return left.editorial.id.localeCompare(right.editorial.id);
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    for (const key of request.nextUrl.searchParams.keys()) {
      if (request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_REQUEST", "Market parameters cannot be repeated.");
      }
    }
    const parsed = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const cursor = decodeCursor(parsed.cursor);
    if (parsed.cursor && !cursor?.id) throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");

    const loaded = await markets.list({
      status: parsed.status,
      category: parsed.category,
      q: parsed.q,
      sort: parsed.sort === "newest" || parsed.sort === "closing" ? parsed.sort : "featured",
      limit: 100,
    });
    const now = new Date();
    const eligible = loaded.filter(market => parsed.status !== "OPEN"
      || market.executionBackend === "SOLANA"
      || market.financial.market.closesAt > now);
    const ordered = routeSort(eligible, parsed.sort);
    const cursorIndex = cursor?.id === undefined ? -1 : ordered.findIndex(market => market.editorial.id === cursor.id);
    if (cursor?.id && cursorIndex < 0) throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");
    const page = ordered.slice(cursorIndex + 1, cursorIndex + 1 + parsed.limit);
    const hasMore = cursorIndex + 1 + page.length < ordered.length;
    const items = page.map(market => market.executionBackend === "DATABASE"
      ? databaseListItem(market)
      : solanaListItem(market));

    return NextResponse.json(
      jsonSafe({ items, nextCursor: hasMore ? encodeCursor({ id: page.at(-1)!.editorial.id }) : null }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
