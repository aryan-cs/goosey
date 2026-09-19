import type { Market, MarketPriceSnapshot } from "@prisma/client";
import { assertDatabaseFinancialMarket } from "./market-backend";
import { formatDistanceToNowStrict } from "date-fns";
import type { MarketSummary, MarketStatus } from "@/components/market";
import { probabilityYesBps } from "@/lib/market-maker";
import { impliedProbabilityBps } from "@/lib/order-book-pricing";

export const MILLI_PER_FEATHER = 1_000n;

export function formatFeathers(milli: bigint, maximumFractionDigits = 0): string {
  const whole = Number(milli) / Number(MILLI_PER_FEATHER);
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits }).format(whole);
}

export function marketProbabilityBps(market: Pick<Market, "executionBackend" | "collateralAccountId" | "yesShares" | "noShares" | "liquidityParameter" | "payoutMilli" | "status" | "resolution"> & { pricingModel?: string }) {
  assertDatabaseFinancialMarket(market);
  if (market.status === "RESOLVED" && market.resolution === "YES") return 10_000;
  if (market.status === "RESOLVED" && market.resolution === "NO") return 0;
  if (market.status === "VOID") return 5_000;
  // Order-book inventories do not encode probabilities. Callers must load a
  // real mark; missing depth is not an implied 50% forecast.
  if (market.pricingModel === "ORDER_BOOK") return null;
  return probabilityYesBps({
    yesQuantity: market.yesShares,
    noQuantity: market.noShares,
    liquidity: market.liquidityParameter,
    payoutMilli: market.payoutMilli,
  });
}

function displayStatus(status: string, closesAt: Date): MarketStatus {
  if (status === "OPEN" && closesAt <= new Date()) return "closed";
  const normalized = status.toLowerCase();
  if (["scheduled", "open", "live", "paused", "closed", "resolving", "resolved", "void"].includes(normalized)) {
    return normalized as MarketStatus;
  }
  return "closed";
}

export function marketSummary(
  market: Market & { priceHistory?: MarketPriceSnapshot[]; orderFills?: Array<{ canonicalYesPriceMilli: bigint; createdAt: Date }> },
  probabilityBps: number | null = marketProbabilityBps(market),
): MarketSummary {
  assertDatabaseFinancialMarket(market);
  const yesBps = probabilityBps;
  const history = market.pricingModel === "ORDER_BOOK"
    ? [...(market.orderFills ?? [])].reverse().map((fill) => ({ createdAt: fill.createdAt, yesProbabilityBps: Number(impliedProbabilityBps(fill.canonicalYesPriceMilli, market.payoutMilli)) }))
    : market.priceHistory ?? [];
  const previous = history.length > 1 ? history.at(-2)!.yesProbabilityBps : yesBps;
  return {
    id: market.id,
    slug: market.slug,
    title: market.title,
    category: market.category,
    closesAt:
      market.closesAt > new Date()
        ? `in ${formatDistanceToNowStrict(market.closesAt)}`
        : `${formatDistanceToNowStrict(market.closesAt)} ago`,
    status: displayStatus(market.status, market.closesAt),
    volume: formatFeathers(market.volumeMilli),
    commentCount: market.commentCount,
    outcomes: [
      { id: "YES", label: "Yes", probability: yesBps === null ? null : yesBps / 10_000, change: yesBps === null || previous === null ? undefined : (yesBps - previous) / 100 },
      { id: "NO", label: "No", probability: yesBps === null ? null : (10_000 - yesBps) / 10_000, change: yesBps === null || previous === null ? undefined : (previous - yesBps) / 100 },
    ],
    sparkline: history.map((point) => ({ timestamp: point.createdAt.toISOString(), probability: point.yesProbabilityBps / 10_000 })),
  };
}
