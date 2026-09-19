"use client";

import Link from "next/link";
import { normalizeChartPoints } from "@/lib/chart-series";
import { ProbabilityPlot } from "./probability-plot";
export { ProbabilityChart } from "./probability-plot";
import { ArrowDownRight, ArrowUpRight, Bookmark, Clock3, MessageCircle, TrendingUp } from "lucide-react";
import { FeatherIcon } from "./brand";
import { MarketStatusLabel } from "./market-status";
import { WatchlistButton } from "./watchlist-button";

export type MarketStatus = "scheduled" | "open" | "live" | "paused" | "closed" | "resolving" | "resolved" | "void";

export interface MarketOutcome {
  id: string;
  label: string;
  probability: number | null;
  change?: number;
}

export interface ProbabilityPoint { timestamp: string | number | Date; probability: number }

export interface MarketSummary {
  id: string;
  slug: string;
  title: string;
  category: string;
  closesAt: string;
  status: MarketStatus;
  volume: number | string;
  commentCount?: number;
  outcomes: MarketOutcome[];
  sparkline?: ProbabilityPoint[];
}

function formatProbability(value: number | null) {
  if (value === null) return "No price";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function MiniSparkline({ values = [] }: { values?: ProbabilityPoint[] }) {
  const series = normalizeChartPoints(values);
  const positive = series.length < 2 || series.at(-1)!.probability >= series[0].probability;
  return <ProbabilityPlot points={series} compact positive={positive} />;
}

function ProbabilityMovement({ change }: { change?: number }) {
  if (change === undefined || !Number.isFinite(change)) return null;
  const magnitude = Number(Math.abs(change).toFixed(2));
  const amount = change !== 0 && magnitude === 0 ? "<0.01" : String(magnitude);
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  return <small className={`movement-${direction}`} title="Change since the previous recorded price" aria-label={`Last change: ${amount} percentage points${change === 0 ? ", unchanged" : change > 0 ? " up" : " down"}`}>
    {change > 0 ? <ArrowUpRight aria-hidden="true" /> : change < 0 ? <ArrowDownRight aria-hidden="true" /> : null}
    <span>{amount} pts</span><span className="movement-period">last change</span>
  </small>;
}

export function MarketCard({ market, priority = false }: { market: MarketSummary; priority?: boolean }) {
  const lead = market.outcomes[0];
  return (
    <article className={`market-card${priority ? " market-card-featured" : ""}`}>
      <div className="market-card-topline">
        <span className="eyebrow">{market.category}</span>
        <WatchlistButton marketId={market.id} icon={<Bookmark size={17} />} />
      </div>
      <Link className="market-title-link" href={`/markets/${market.slug}`}><h3><span>{market.title}</span></h3></Link>
      <div className="status-row">
        <MarketStatusLabel status={market.status} />
        <span><Clock3 size={14} /> {market.closesAt}</span>
      </div>
      {lead && (
        <div className="market-primary">
          <MiniSparkline values={market.sparkline} />
          <div className="probability-block">
            <span>{lead.label}</span>
            <strong>{formatProbability(lead.probability)}</strong>
            <ProbabilityMovement change={lead.change} />
          </div>
        </div>
      )}
      <div className="outcome-actions" aria-label="Trade outcomes">
        {market.outcomes.slice(0, 2).map((outcome) => (
          <Link href={`/markets/${market.slug}?outcome=${encodeURIComponent(outcome.id)}`} key={outcome.id}>
            <span>{outcome.label}</span><strong>{formatProbability(outcome.probability)}</strong>
          </Link>
        ))}
      </div>
      <footer className="market-card-footer">
        <span><FeatherIcon /> {market.volume} vol.</span>
        {market.commentCount !== undefined && <span><MessageCircle /> {market.commentCount}</span>}
      </footer>
    </article>
  );
}

export function MarketListRow({ market, className }: { market: MarketSummary; className?: string }) {
  const lead = market.outcomes[0];
  return (
    <article className={`market-list-row${className ? ` ${className}` : ""}`}>
      <Link className="market-list-main" href={`/markets/${market.slug}`}>
        <span className="market-list-icon"><TrendingUp /></span>
        <span><small>{market.category}</small><strong>{market.title}</strong></span>
      </Link>
      <MiniSparkline values={market.sparkline} />
      <span className="market-list-meta"><small>Volume</small><strong><FeatherIcon /> {market.volume}</strong></span>
      <span className="market-list-meta"><small>Closes</small><strong>{market.closesAt}</strong></span>
      {lead && <span className="market-list-probability"><strong>{formatProbability(lead.probability)}</strong><ProbabilityMovement change={lead.change} /></span>}
    </article>
  );
}
