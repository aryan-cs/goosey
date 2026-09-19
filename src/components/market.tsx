"use client";

import Link from "next/link";
import { ProbabilityPlot } from "./probability-plot";
export { ProbabilityChart } from "./probability-plot";
import { ArrowDownRight, ArrowUpRight, Bookmark, Clock3, MessageCircle, Radio, TrendingUp } from "lucide-react";
import { FeatherIcon } from "./brand";
import { WatchlistButton } from "./watchlist-button";

export type MarketStatus = "scheduled" | "open" | "live" | "paused" | "closed" | "resolving" | "resolved" | "void";

export interface MarketOutcome {
  id: string;
  label: string;
  probability: number;
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

function formatProbability(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function MiniSparkline({ values = [], positive = true }: { values?: ProbabilityPoint[]; positive?: boolean }) {
  return <ProbabilityPlot points={values} compact positive={positive} />;
}

export function MarketCard({ market, priority = false }: { market: MarketSummary; priority?: boolean }) {
  const lead = market.outcomes[0];
  const positive = (lead?.change ?? 0) >= 0;
  return (
    <article className={`market-card${priority ? " market-card-featured" : ""}`}>
      <div className="market-card-topline">
        <span className="eyebrow">{market.category}</span>
        <WatchlistButton marketId={market.id} icon={<Bookmark size={17} />} />
      </div>
      <Link className="market-title-link" href={`/markets/${market.slug}`}><h3>{market.title}</h3></Link>
      <div className="status-row">
        <span className={`status-pill status-${market.status}`}>{market.status === "live" && <Radio size={12} />} {market.status}</span>
        <span><Clock3 size={14} /> {market.closesAt}</span>
      </div>
      {lead && (
        <div className="market-primary">
          <MiniSparkline values={market.sparkline} positive={positive} />
          <div className="probability-block">
            <span>{lead.label}</span>
            <strong>{formatProbability(lead.probability)}</strong>
            {lead.change !== undefined && <small className={positive ? "movement-up" : "movement-down"}>{positive ? <ArrowUpRight /> : <ArrowDownRight />}{Math.abs(lead.change).toFixed(1)}%</small>}
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

export function MarketListRow({ market }: { market: MarketSummary }) {
  const lead = market.outcomes[0];
  const positive = (lead?.change ?? 0) >= 0;
  return (
    <article className="market-list-row">
      <Link className="market-list-main" href={`/markets/${market.slug}`}>
        <span className="market-list-icon"><TrendingUp /></span>
        <span><small>{market.category}</small><strong>{market.title}</strong></span>
      </Link>
      <MiniSparkline values={market.sparkline} positive={positive} />
      <span className="market-list-meta"><small>Volume</small><strong>🪶 {market.volume}</strong></span>
      <span className="market-list-meta"><small>Closes</small><strong>{market.closesAt}</strong></span>
      {lead && <span className="market-list-probability"><strong>{formatProbability(lead.probability)}</strong><small className={positive ? "movement-up" : "movement-down"}>{positive ? "+" : ""}{lead.change ?? 0}%</small></span>}
    </article>
  );
}
