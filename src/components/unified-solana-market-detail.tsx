import Link from "next/link";
import { CalendarClock, ChevronRight, Users } from "lucide-react";
import type { ReactNode } from "react";

import { FeatherIcon } from "@/components/brand";
import { MarketStatusLabel } from "@/components/market-status";
import { formatFeathers } from "@/lib/feather-format";
import type { UnifiedSolanaMarket } from "@/lib/unified-market-repository";

import styles from "./unified-solana-market-detail.module.css";

export type UnifiedSolanaMarketDetailProps = Readonly<{
  market: UnifiedSolanaMarket;
  watchAction?: ReactNode;
  shareAction?: ReactNode;
  discussion?: ReactNode;
}>;

const dateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Toronto",
});

function formatProbability(bps: number | null) {
  if (bps === null) return "N/A";
  const percentage = bps / 100;
  return `${Number.isInteger(percentage) ? percentage.toFixed(0) : percentage.toFixed(1)}%`;
}

function statusLabel(market: UnifiedSolanaMarket) {
  if (market.financial.status === "OPEN" && !market.financial.acceptingOrders) return "closed";
  return market.financial.status.toLowerCase();
}

function safeSource(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function PriceHistory({ market }: { market: UnifiedSolanaMarket }) {
  const trades = [...market.financial.recentTrades].reverse();
  if (!trades.length) {
    return <div className={styles.emptyChart}>No executions yet</div>;
  }

  const payout = market.financial.payoutMilli;
  const values = trades.map((trade) => payout > 0n
    ? Number((trade.yesPriceMilli * 10_000n) / payout) / 10_000
    : 0);
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 50 : index / (values.length - 1) * 100;
    return `${x},${100 - Math.max(0, Math.min(1, value)) * 100}`;
  }).join(" ");
  const first = trades[0];
  const last = trades.at(-1)!;

  return <div className={styles.history}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Recent YES execution prices from ${formatProbability(Math.round(values[0] * 10_000))} to ${formatProbability(Math.round(values.at(-1)! * 10_000))}`}>
      <line x1="0" x2="100" y1="50" y2="50" />
      {values.length === 1
        ? <circle cx="50" cy={100 - values[0] * 100} r="2" vectorEffect="non-scaling-stroke" />
        : <polyline points={points} vectorEffect="non-scaling-stroke" />}
    </svg>
    <div className={styles.historyAxis}><span>Slot {first.slot.toString()}</span><span>Slot {last.slot.toString()}</span></div>
  </div>;
}

type Level = UnifiedSolanaMarket["financial"]["bids"][number];

function BookSide({ label, levels, payoutMilli, side }: {
  label: string;
  levels: readonly Level[];
  payoutMilli: bigint;
  side: "bid" | "ask";
}) {
  const ordered = [...levels].sort((left, right) => {
    if (left.priceMilli === right.priceMilli) return 0;
    const ascending = left.priceMilli < right.priceMilli ? -1 : 1;
    return side === "ask" ? ascending : -ascending;
  });
  const maxQuantity = ordered.reduce((maximum, level) => level.quantity > maximum ? level.quantity : maximum, 0n);
  return <section className={styles.bookSide} aria-label={label}>
    <h3>{label}</h3>
    <div className={styles.bookHead}><span>YES price</span><span>Contracts</span></div>
    {ordered.length ? <ol>
      {ordered.map((level, index) => {
        const width = maxQuantity > 0n ? Number(level.quantity * 1_000n / maxQuantity) / 10 : 0;
        const probability = payoutMilli > 0n
          ? Number(level.priceMilli * 10_000n / payoutMilli)
          : null;
        return <li key={`${level.priceMilli}-${index}`}>
          <span className={styles.depth} style={{ width: `${width}%` }} />
          <strong>{formatFeathers(level.priceMilli, 3)} <small>{formatProbability(probability)}</small></strong>
          <span>{level.quantity.toLocaleString("en-CA")}</span>
        </li>;
      })}
    </ol> : <p className={styles.emptyBook}>No resting orders</p>}
  </section>;
}

function resolutionText(value: UnifiedSolanaMarket["financial"]["resolution"]) {
  if (value === null) return null;
  return value === "VOID" ? "This market was voided." : `This market resolved ${value}.`;
}

export function UnifiedSolanaMarketDetail({ market, watchAction, shareAction, discussion }: UnifiedSolanaMarketDetailProps) {
  const { editorial, financial } = market;
  const source = safeSource(editorial.resolutionSource);
  const actions = watchAction || shareAction;
  const resolved = resolutionText(financial.resolution);

  return <div className={`page-shell market-detail-page ${styles.page}`}>
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <Link href="/markets">Markets</Link><ChevronRight />
      <Link href={`/markets?category=${encodeURIComponent(editorial.category)}`}>{editorial.category}</Link>
    </nav>
    <div className={styles.layout}>
      <main className={styles.main}>
        <header className="market-detail-header">
          <div>
            <span className="eyebrow">{editorial.category}</span>
            <h1>{editorial.title}</h1>
            <div className="market-meta">
              <MarketStatusLabel status={statusLabel(market)} />
              <span><CalendarClock /> Closes <time dateTime={financial.closesAt.toISOString()}>{dateTimeFormat.format(financial.closesAt)}</time></span>
              <span><Users /> {financial.traderCount.toLocaleString("en-CA")} trader{financial.traderCount === 1 ? "" : "s"}</span>
            </div>
          </div>
          {actions && <div className="market-header-actions">{watchAction}{shareAction}</div>}
        </header>

        <section className={styles.forecast} aria-labelledby="forecast-heading">
          <div className={styles.forecastHeader}>
            <div><span className="eyebrow">Current forecast</span><h2 id="forecast-heading">YES {formatProbability(financial.probabilityYesBps)}</h2></div>
            <span>{financial.probabilitySource === "SETTLEMENT" ? "Final result" : financial.probabilitySource === "MID" ? "Order-book midpoint" : "Awaiting a market price"}</span>
          </div>
          <PriceHistory market={market} />
        </section>

        <section className={styles.orderBook} aria-labelledby="order-book-heading">
          <div className={styles.sectionHeading}><div><span className="eyebrow">Market depth</span><h2 id="order-book-heading">Order book</h2></div><span>Finalized snapshot</span></div>
          <div className={styles.bookGrid}>
            <BookSide label="Bids" levels={financial.bids} payoutMilli={financial.payoutMilli} side="bid" />
            <BookSide label="Asks" levels={financial.asks} payoutMilli={financial.payoutMilli} side="ask" />
          </div>
        </section>

        <section className="market-copy"><span className="eyebrow">About this market</span><h2>What to know</h2><p>{editorial.description}</p></section>

        <section className="rules-panel" aria-labelledby="rules-heading">
          <div className="section-heading"><div><span className="eyebrow">How it is decided</span><h2 id="rules-heading">Market rules</h2></div></div>
          <p>{editorial.rules}</p>
          {resolved && <p className={styles.resolution} role="status">{resolved}</p>}
          <div className="resolution-source"><strong>Source</strong>{source ? <a href={source.toString()} rel="noreferrer" target="_blank">{editorial.resolutionSource}</a> : <span>{editorial.resolutionSource}</span>}</div>
          <dl>
            <div><dt>Trading closes</dt><dd>{dateTimeFormat.format(financial.closesAt)}</dd></div>
            <div><dt>Expected result</dt><dd>{dateTimeFormat.format(financial.resolvesAt)}</dd></div>
            <div><dt>Winner pays</dt><dd>{formatFeathers(financial.payoutMilli, 3)} feathers</dd></div>
          </dl>
        </section>

        <section className="activity-panel" aria-labelledby="activity-heading">
          <div className="section-heading"><h2 id="activity-heading">Recent activity</h2></div>
          {financial.recentTrades.length ? <ul className="trade-feed">
            {financial.recentTrades.map((trade) => <li key={`${trade.signature}-${trade.logIndex}`}>
              <span className="activity-dot yes" />
              <span><strong>{trade.quantity.toLocaleString("en-CA")} contract{trade.quantity === 1n ? "" : "s"}</strong>{" matched at YES "}{formatFeathers(trade.yesPriceMilli, 3)} feathers</span>
              <span className={styles.slot}>Slot {trade.slot.toString()}</span>
            </li>)}
          </ul> : <p className="muted-copy">No executions yet.</p>}
          {!financial.recentTradeWindowComplete && <p className={styles.windowNote}>Showing the most recent finalized activity.</p>}
        </section>
      </main>

      <aside className={styles.tradeCard} aria-labelledby="trade-heading">
        <span className="eyebrow">Trade</span>
        <h2 id="trade-heading">Choose an outcome</h2>
        <p>Order entry is temporarily unavailable while trading is being connected.</p>
        <div className={styles.tradeChoices}>
          <button type="button" disabled>Buy YES</button>
          <button type="button" disabled>Buy NO</button>
        </div>
        <dl>
          <div><dt>Current forecast</dt><dd>{formatProbability(financial.probabilityYesBps)}</dd></div>
          <div><dt>Payout</dt><dd><FeatherIcon /> {formatFeathers(financial.payoutMilli, 3)}</dd></div>
          <div><dt>Fee</dt><dd>{financial.feeBps / 100}%</dd></div>
        </dl>
        <button className={styles.submit} type="button" disabled>Trading unavailable</button>
      </aside>
    </div>
    {discussion && <div className={styles.discussion}>{discussion}</div>}
  </div>;
}
