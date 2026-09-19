import type { Market, MarketPriceSnapshot } from "@prisma/client";
import { formatDistanceToNowStrict } from "date-fns";
import type { MarketSummary, MarketStatus } from "@/components/market";
import { probabilityYesBps } from "@/lib/market-maker";

export const MILLI_PER_FEATHER = 1_000n;

export function formatFeathers(milli: bigint, maximumFractionDigits = 0): string {
  const whole = Number(milli) / Number(MILLI_PER_FEATHER);
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits }).format(whole);
}

export function marketProbabilityBps(market: Pick<Market, "yesShares" | "noShares" | "liquidityParameter" | "payoutMilli" | "status" | "resolution">) {
  if (market.status === "RESOLVED" && market.resolution === "YES") return 10_000;
  if (market.status === "RESOLVED" && market.resolution === "NO") return 0;
  if (market.status === "VOID") return 5_000;
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
  market: Market & { priceHistory?: MarketPriceSnapshot[] },
): MarketSummary {
  const yesBps = marketProbabilityBps(market);
  const history = market.priceHistory ?? [];
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
      { id: "YES", label: "Yes", probability: yesBps / 10_000, change: (yesBps - previous) / 100 },
      { id: "NO", label: "No", probability: (10_000 - yesBps) / 10_000, change: (previous - yesBps) / 100 },
    ],
    sparkline: history.map((point) => ({ timestamp: point.createdAt.toISOString(), probability: point.yesProbabilityBps / 10_000 })),
  };
}
