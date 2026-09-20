"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, BarChart3, CalendarDays, Search, WalletCards } from "lucide-react";

import { FeatherIcon } from "@/components/brand";
import { EmptyState } from "@/components/states";
import { initials } from "@/lib/initials";
import styles from "./public-profile-dashboard.module.css";
import { UserProfileLink } from "./user-profile-link";

type Point = { timestamp: string; value: number };
type Position = { id: string; marketSlug: string; marketTitle: string; marketStatus: string; side: "YES" | "NO"; quantity: number; averagePrice: number; probability: number | null; value: string; pnl: string; pnlPositive: boolean };
type Trade = { id: string; marketSlug: string; marketTitle: string; side: string; action: string; quantity: number; amount: string; fee: string; createdAt: string; source: string };

export interface PublicProfileDashboardProps {
  identity: { username: string; displayName: string; bio: string | null; joinedAt: string };
  summary: { equity: string; pnl: string; pnlPositive: boolean; volume: string; trades: number; marketsTraded: number; availableCash: string; reservedCash: string; positionValue: string };
  positions: Position[];
  recentTrades: Trade[];
  balanceSeries: Point[];
  volumeSeries: Point[];
}

type Range = "1D" | "1W" | "1M" | "ALL";
type ChartKind = "balance" | "volume";

function numberLabel(value: number) {
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(value);
}

function chartPath(points: Point[], width: number, height: number) {
  if (!points.length) return { line: "", area: "", min: 0, max: 0 };
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const x = (index: number) => points.length === 1 ? width / 2 : index / (points.length - 1) * width;
  const y = (value: number) => height - ((value - min) / span) * (height - 12) - 6;
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
  return { line, area: `${line} L${width},${height} L0,${height} Z`, min, max };
}

function rangePoints(points: Point[], range: Range) {
  if (range === "ALL" || points.length < 2) return points;
  const days = range === "1D" ? 1 : range === "1W" ? 7 : 30;
  const cutoff = Date.now() - days * 86_400_000;
  const firstInRange = points.findIndex((point) => Date.parse(point.timestamp) >= cutoff);
  if (firstInRange <= 0) return firstInRange === -1 ? points.slice(-1) : points;
  return points.slice(firstInRange - 1);
}

function HistoryChart({ balanceSeries, volumeSeries }: { balanceSeries: Point[]; volumeSeries: Point[] }) {
  const [kind, setKind] = useState<ChartKind>("balance");
  const [range, setRange] = useState<Range>("ALL");
  const points = useMemo(() => rangePoints(kind === "balance" ? balanceSeries : volumeSeries, range), [balanceSeries, volumeSeries, kind, range]);
  const chart = chartPath(points, 720, 246);
  const current = points.at(-1)?.value ?? 0;
  const delta = current - (points.at(0)?.value ?? current);
  const label = kind === "balance" ? "Available balance" : "Cumulative volume";

  return <section className={styles.chartCard} aria-labelledby="profile-history-heading">
    <div className={styles.chartHeading}>
      <div><span>{label}</span><strong><FeatherIcon /> {numberLabel(current)}</strong><small className={delta >= 0 ? styles.positive : styles.negative}>{delta >= 0 ? "+" : "−"}<FeatherIcon /> {numberLabel(Math.abs(delta))} in range</small></div>
      <div className={styles.chartKinds} role="group" aria-label="Chart metric"><button type="button" aria-pressed={kind === "balance"} onClick={() => setKind("balance")}>Balance</button><button type="button" aria-pressed={kind === "volume"} onClick={() => setKind("volume")}>Volume</button></div>
    </div>
    <h2 id="profile-history-heading" className="sr-only">Account history</h2>
    {points.length ? <div className={styles.chart}>
      <div className={styles.axis}><span>{numberLabel(chart.max)}</span><span>{numberLabel((chart.max + chart.min) / 2)}</span><span>{numberLabel(chart.min)}</span></div>
      <svg viewBox="0 0 720 246" role="img" aria-label={`${label} over time, currently ${numberLabel(current)} feathers`} preserveAspectRatio="none"><defs><linearGradient id={`profile-${kind}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".22"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs><path className={styles.area} d={chart.area} fill={`url(#profile-${kind}-fill)`}/><path className={styles.line} d={chart.line}/></svg>
    </div> : <div className={styles.chartEmpty}><BarChart3 /><span>No {kind} history yet</span></div>}
    <div className={styles.rangeTabs} role="group" aria-label="Chart range">{(["1D", "1W", "1M", "ALL"] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => setRange(value)}>{value}</button>)}</div>
  </section>;
}

export function PublicProfileDashboard(props: PublicProfileDashboardProps) {
  const [tab, setTab] = useState<"positions" | "activity">("positions");
  const [positionFilter, setPositionFilter] = useState<"active" | "all">("active");
  const [query, setQuery] = useState("");
  const positions = props.positions.filter((position) => (positionFilter === "all" || ["OPEN", "PAUSED", "RESOLVING", "CLOSED"].includes(position.marketStatus)) && position.marketTitle.toLowerCase().includes(query.toLowerCase()));

  return <div className={styles.dashboard}>
    <div className={styles.overview}>
      <section className={styles.identityCard} aria-labelledby="profile-name">
        <div className={styles.identity}><div className={styles.avatar} aria-hidden="true">{initials(props.identity.displayName)}</div><div><h1 id="profile-name">{props.identity.displayName}</h1><p><UserProfileLink username={props.identity.username}>@{props.identity.username}</UserProfileLink></p></div></div>
        {props.identity.bio && <p className={styles.bio}>{props.identity.bio}</p>}
        <p className={styles.joined}><CalendarDays /> Joined {new Date(props.identity.joinedAt).toLocaleDateString("en-CA", { month: "long", year: "numeric", timeZone: "America/Toronto" })}</p>
        <dl className={styles.metrics}>
          <div><dt>Portfolio value</dt><dd><FeatherIcon /> {props.summary.equity}</dd></div>
          <div><dt>Profit / loss</dt><dd className={props.summary.pnlPositive ? styles.positive : styles.negative}>{props.summary.pnlPositive ? "+" : "−"}<FeatherIcon /> {props.summary.pnl}</dd></div>
          <div><dt>Volume</dt><dd><FeatherIcon /> {props.summary.volume}</dd></div>
          <div><dt>Predictions</dt><dd>{props.summary.trades.toLocaleString("en-CA")}</dd></div>
          <div><dt>Markets</dt><dd>{props.summary.marketsTraded.toLocaleString("en-CA")}</dd></div>
        </dl>
        <details className={styles.breakdown}><summary>Portfolio breakdown</summary><dl><div><dt>Available</dt><dd><FeatherIcon /> {props.summary.availableCash}</dd></div><div><dt>Reserved</dt><dd><FeatherIcon /> {props.summary.reservedCash}</dd></div><div><dt>Positions</dt><dd><FeatherIcon /> {props.summary.positionValue}</dd></div></dl></details>
      </section>
      <HistoryChart balanceSeries={props.balanceSeries} volumeSeries={props.volumeSeries} />
    </div>

    <section className={styles.records}>
      <div className={styles.tabs} role="tablist" aria-label="Profile records"><button type="button" role="tab" aria-selected={tab === "positions"} onClick={() => setTab("positions")}><WalletCards /> Positions <span>{props.positions.length}</span></button><button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}><Activity /> Activity <span>{props.recentTrades.length}</span></button></div>
      {tab === "positions" ? <>
        <div className={styles.toolbar}><div className={styles.filters} role="group" aria-label="Position status"><button type="button" aria-pressed={positionFilter === "active"} onClick={() => setPositionFilter("active")}>Active</button><button type="button" aria-pressed={positionFilter === "all"} onClick={() => setPositionFilter("all")}>All</button></div><label className={styles.search}><Search /><span className="sr-only">Search positions</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search positions" /></label></div>
        {positions.length ? <div className={styles.positionTable}><div className={styles.tableHeader}><span>Market</span><span>Contracts</span><span>Avg.</span><span>Forecast</span><span>Value</span><span>P/L</span></div>{positions.map((position) => <Link key={position.id} className={styles.positionRow} href={`/markets/${encodeURIComponent(position.marketSlug)}?outcome=${position.side}`}><span className={styles.marketCell}><b className={position.side === "YES" ? styles.yes : styles.no}>{position.side}</b><span><strong>{position.marketTitle}</strong><small>{position.marketStatus.toLowerCase().replaceAll("_", " ")}</small></span></span><span data-label="Contracts">{position.quantity.toLocaleString("en-CA")}</span><span data-label="Average">{Math.round(position.averagePrice)}%</span><span data-label="Forecast">{position.probability === null ? "—" : `${Math.round(position.probability)}%`}</span><span data-label="Value"><FeatherIcon /> {position.value}</span><span data-label="P/L" className={position.pnlPositive ? styles.positive : styles.negative}>{position.pnlPositive ? "+" : "−"}<FeatherIcon /> {position.pnl}</span></Link>)}</div> : <EmptyState title={query ? "No matching positions" : "No positions yet"} description={query ? "Try another market name." : "This account has no positions to show."} />}
      </> : props.recentTrades.length ? <div className={styles.activityList}>{props.recentTrades.map((trade) => <Link className={styles.activityRow} href={`/markets/${encodeURIComponent(trade.marketSlug)}?outcome=${trade.side}`} key={trade.id}><span className={trade.side === "YES" ? styles.yesDot : styles.noDot}/><span><strong>{trade.marketTitle}</strong><small>{trade.action.toLowerCase()} {trade.quantity.toLocaleString("en-CA")} {trade.side} · {trade.source === "ORDER_BOOK" ? "Order book" : "Market maker"}</small></span><b><FeatherIcon /> {trade.amount}</b><time dateTime={trade.createdAt}>{new Date(trade.createdAt).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></Link>)}</div> : <EmptyState title="No trades yet" description="Recent executions will appear here." />}
    </section>
  </div>;
}
