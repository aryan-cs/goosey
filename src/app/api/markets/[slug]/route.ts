import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedUser } from "@/lib/auth";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { loadMarketMarks } from "@/lib/market-marks";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { jsonSafe } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import {
  createUnifiedMarketReadRepository,
  type UnifiedDatabaseMarket,
  type UnifiedSolanaMarket,
} from "@/lib/unified-market-repository";

export const dynamic = "force-dynamic";
const slugSchema = z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const markets = createUnifiedMarketReadRepository({ client: prisma });
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;

async function databaseDetail(market: UnifiedDatabaseMarket) {
  const row = market.financial.market;
  const mark = market.financial.mark;
  const { orderFills, ...summary } = row;
  const createdBy = await prisma.user.findUnique({
    where: { id: row.createdById },
    select: { username: true, displayName: true },
  });
  return {
    ...summary,
    createdBy,
    collateralAccountId: undefined,
    createdById: undefined,
    probabilityYesBps: mark.probabilityYesBps,
    probabilitySource: mark.source,
    probabilityStale: mark.stale,
    priceHistory: row.pricingModel === "ORDER_BOOK"
      ? orderFills.map(fill => ({
          createdAt: fill.createdAt,
          yesProbabilityBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, row.payoutMilli)),
        }))
      : row.priceHistory,
  };
}

function solanaDetail(market: UnifiedSolanaMarket) {
  const { editorial, financial } = market;
  return {
    ...editorial,
    status: financial.status === "RESOLVING" ? "CLOSED" : financial.status,
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

async function loadAdministratorDraft(slug: string) {
  return runSerializableTransaction(prisma, async tx => {
    const market = await tx.market.findUnique({
      where: { slug },
      include: {
        createdBy: { select: { username: true, displayName: true } },
        priceHistory: { orderBy: { createdAt: "desc" }, take: 1 },
        orderFills: {
          orderBy: { tradeSequence: "desc" },
          take: 1,
          select: { createdAt: true, canonicalYesPriceMilli: true },
        },
      },
    });
    if (!market || market.status !== "DRAFT" || market.executionBackend !== "DATABASE" || !market.collateralAccountId) {
      return null;
    }
    const mark = (await loadMarketMarks(tx, [market])).get(market.id);
    if (!mark) throw new Error("Database market mark is unavailable");
    const { orderFills, ...summary } = market;
    return {
      ...summary,
      collateralAccountId: undefined,
      createdById: undefined,
      probabilityYesBps: mark.probabilityYesBps,
      probabilitySource: mark.source,
      probabilityStale: mark.stale,
      priceHistory: market.pricingModel === "ORDER_BOOK"
        ? orderFills.map(fill => ({
            createdAt: fill.createdAt,
            yesProbabilityBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)),
          }))
        : market.priceHistory,
    };
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const slug = slugSchema.parse((await context.params).slug);
    const user = await getAuthenticatedUser(request);
    const market = await markets.findBySlug(slug);
    if (market) {
      return NextResponse.json(
        jsonSafe(market.executionBackend === "DATABASE" ? await databaseDetail(market) : solanaDetail(market)),
        { headers: PRIVATE_HEADERS },
      );
    }
    if (user?.role === "ADMIN") {
      const draft = await loadAdministratorDraft(slug);
      if (draft) return NextResponse.json(jsonSafe(draft), { headers: PRIVATE_HEADERS });
    }
    throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  } catch (error) {
    return apiErrorResponse(error);
  }
}
