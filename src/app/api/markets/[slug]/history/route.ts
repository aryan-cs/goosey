import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, prisma } from "@/lib/market-service";
import { jsonSafe } from "@/lib/serializers";
import { getAuthenticatedUser } from "@/lib/auth";
import { boundedPriceHistory } from "@/lib/price-history";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();
const querySchema = z
  .object({
    range: z.enum(["1D", "1W", "1M", "ALL"]).default("1W"),
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
  })
  .strict();

function parseQuery(searchParams: URLSearchParams) {
  for (const key of searchParams.keys()) {
    if (!["range", "limit"].includes(key) || searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_REQUEST", "Unknown or repeated history parameter.");
    }
  }
  return querySchema.parse(Object.fromEntries(searchParams));
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const query = parseQuery(request.nextUrl.searchParams);
    const duration = { "1D": 86_400_000, "1W": 604_800_000, "1M": 2_592_000_000 } as const;
    const since = query.range === "ALL" ? undefined : new Date(Date.now() - duration[query.range]);
    const payload = await runSerializableTransaction(prisma, async (tx) => {
      const market = await tx.market.findUnique({ where: { slug }, select: { id: true, status: true, pricingModel: true, payoutMilli: true } });
      if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      if (market.status === "DRAFT" && (await getAuthenticatedUser(request))?.role !== "ADMIN") {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      }

      if (market.pricingModel === "ORDER_BOOK") {
        const [fills, priorFill] = await Promise.all([
          tx.orderFill.findMany({ where: { marketId: market.id, ...(since ? { createdAt: { gte: since } } : {}) }, orderBy: [{ createdAt: "asc" }, { tradeSequence: "asc" }, { id: "asc" }], select: { id: true, createdAt: true, tradeSequence: true, canonicalYesPriceMilli: true } }),
          since ? tx.orderFill.findFirst({ where: { marketId: market.id, createdAt: { lt: since } }, orderBy: [{ createdAt: "desc" }, { tradeSequence: "desc" }, { id: "desc" }], select: { id: true, createdAt: true, tradeSequence: true, canonicalYesPriceMilli: true } }) : Promise.resolve(null),
        ]);
        const observations = (priorFill ? [priorFill, ...fills] : fills).map((fill) => ({ id: fill.id, timestamp: fill.createdAt, probabilityYesBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)) }));
        const snapshots = boundedPriceHistory(observations, query.limit).map((point) => ({ id: point.id, marketId: market.id, yesProbabilityBps: point.probabilityYesBps, createdAt: point.timestamp }));
        return { snapshots, trades: [], range: query.range, rangeStart: since ?? null, sampledFrom: observations.length, downsampled: observations.length > snapshots.length, source: "EXECUTIONS" };
      }

      const [rawSnapshots, priorSnapshot, trades] = await Promise.all([
        tx.marketPriceSnapshot.findMany({
          where: { marketId: market.id, ...(since ? { createdAt: { gte: since } } : {}) },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        }),
        since ? tx.marketPriceSnapshot.findFirst({
          where: { marketId: market.id, createdAt: { lt: since } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        }) : Promise.resolve(null),
        tx.trade.findMany({
          where: { marketId: market.id, ...(since ? { createdAt: { gte: since } } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: Math.min(query.limit, 100),
          select: {
            id: true,
            side: true,
            action: true,
            quantity: true,
            amountMilli: true,
            feeMilli: true,
            priceBeforeBps: true,
            priceAfterBps: true,
            createdAt: true,
          },
        }),
      ]);
      const sourceSnapshots = priorSnapshot ? [priorSnapshot, ...rawSnapshots] : rawSnapshots;
      const snapshots = boundedPriceHistory(
        sourceSnapshots.map((snapshot) => ({ ...snapshot, timestamp: snapshot.createdAt, probabilityYesBps: snapshot.yesProbabilityBps })),
        query.limit,
      ).map((snapshot) => ({
        id: snapshot.id,
        marketId: snapshot.marketId,
        yesProbabilityBps: snapshot.probabilityYesBps,
        createdAt: snapshot.createdAt,
      }));
      return { snapshots, trades, range: query.range, rangeStart: since ?? null, sampledFrom: sourceSnapshots.length, downsampled: sourceSnapshots.length > snapshots.length };
    });
    return NextResponse.json(jsonSafe(payload), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
