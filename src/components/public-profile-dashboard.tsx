"use client";

import Link from "next/link";
import { useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { Activity, BarChart3, CalendarDays, Search, WalletCards } from "lucide-react";

import { FeatherIcon } from "@/components/brand";
import { EmptyState } from "@/components/states";
import { LocalTime } from "@/components/local-time";
import { heldProfileHistoryPoint, normalizeProfileHistory, profileHistoryStepPath, selectProfileHistoryRange, type NormalizedProfileHistoryPoint } from "@/components/public-profile-history";
import { initials } from "@/lib/initials";
import { formatLocalTime } from "@/lib/local-time";
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
  asOf: string;
}

type Range = "1D" | "1W" | "1M" | "ALL";
type ChartKind = "balance" | "volume";

function numberLabel(value: number) {
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(value);
}

function visiblePoints(points: NormalizedProfileHistoryPoint[], range: Range, asOf: number) {
  if (!points.length) return { points, start: asOf, end: asOf };
  const duration = range === "1D" ? 86_400_000 : range === "1W" ? 604_800_000 : range === "1M" ? 2_592_000_000 : null;
  const start = duration === null ? points[0].timestamp : asOf - duration;
  const selected = selectProfileHistoryRange(points, start, asOf);
  return { points: selected.length ? selected : [points.at(-1)!], start, end: Math.max(asOf, start + 1) };
}

function chartPath(points: NormalizedProfileHistoryPoint[], width: number, height: number, start: number, end: number) {
  if (!points.length) return { line: "", area: "", min: 0, max: 0 };
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 1);
  const x = (time: number) => ((Math.min(end, Math.max(start, time)) - start) / Math.max(end - start, 1)) * width;
  const y = (value: number) => height - ((value - min) / span) * (height - 12) - 6;
  const line = profileHistoryStepPath(points, { startAt: start, endAt: end, width, height, minValue: min - span * (6 / (height - 12)), maxValue: max + span * (6 / (height - 12)) });
  return { line, area: `${line} L${width},${height} L0,${height} Z`, min, max, x, y };
}

function HistoryChart({ balanceSeries, volumeSeries, asOf }: { balanceSeries: Point[]; volumeSeries: Point[]; asOf: string }) {
  const [kind, setKind] = useState<ChartKind>("balance");
  const [range, setRange] = useState<Range>("ALL");
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const asOfTime = Date.parse(asOf);
  const normalized = useMemo(() => normalizeProfileHistory(kind === "balance" ? balanceSeries : volumeSeries), [balanceSeries, volumeSeries, kind]);
  const visible = useMemo(() => visiblePoints(normalized, range, asOfTime), [normalized, range, asOfTime]);
  const points = visible.points;
  const chart = chartPath(points, 720, 246, visible.start, visible.end);
  const current = points.at(-1)?.value ?? 0;
  const delta = current - (points.at(0)?.value ?? current);
  const label = kind === "balance" ? "Available balance" : "Cumulative volume";
  const inspectedTime = cursorTime === null ? null : Math.min(visible.end, Math.max(visible.start, cursorTime));
  const inspected = inspectedTime === null ? null : heldProfileHistoryPoint(points, inspectedTime) ?? points[0];
  const inspectedDelta = inspected ? inspected.value - (points[0]?.value ?? inspected.value) : 0;
  const cursorX = inspectedTime === null ? 0 : ((inspectedTime - visible.start) / Math.max(visible.end - visible.start, 1)) * 100;
  const tooltipX = Math.min(88, Math.max(12, cursorX));
  const cursorY = inspected && chart.y ? (chart.y(inspected.value) / 246) * 100 : 0;
  const kindStyle = { "--segment-count": 2, "--segment-index": kind === "balance" ? 0 : 1 } as CSSProperties;
  const rangeStyle = { "--segment-count": 4, "--segment-index": ["1D", "1W", "1M", "ALL"].indexOf(range) } as CSSProperties;

  function inspectPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = plotRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setCursorTime(visible.start + ratio * (visible.end - visible.start));
  }

  function inspectKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const times = [...new Set([visible.start, ...points.map((point) => point.timestamp), visible.end])].sort((a, b) => a - b);
    const active = inspectedTime ?? visible.end;
    const index = times.reduce((closest, time, candidate) => Math.abs(time - active) < Math.abs(times[closest] - active) ? candidate : closest, 0);
    let next: number | undefined;
    if (event.key === "Home") next = times[0];
    if (event.key === "End") next = times.at(-1);
    if (event.key === "ArrowLeft") next = times[Math.max(0, index - 1)];
    if (event.key === "ArrowRight") next = times[Math.min(times.length - 1, index + 1)];
    if (event.key === "Escape") setCursorTime(null);
    if (next !== undefined) { event.preventDefault(); setCursorTime(next); }
  }

  return <section className={styles.chartCard} aria-labelledby="profile-history-heading">
    <div className={styles.chartHeading}>
      <div><span>{inspected ? `Historical ${label.toLowerCase()}` : label}</span><strong><FeatherIcon /> {numberLabel(inspected?.value ?? current)}</strong><small className={(inspected ? inspectedDelta : delta) >= 0 ? styles.positive : styles.negative}>{(inspected ? inspectedDelta : delta) >= 0 ? "+" : "−"}<FeatherIcon /> {numberLabel(Math.abs(inspected ? inspectedDelta : delta))} {inspected ? "since range start" : "in range"}</small></div>
      <div className={styles.segmented} style={kindStyle} role="group" aria-label="Chart metric"><span className={styles.segmentIndicator} aria-hidden="true"/><button type="button" aria-pressed={kind === "balance"} onClick={() => { setKind("balance"); setCursorTime(null); }}>Balance</button><button type="button" aria-pressed={kind === "volume"} onClick={() => { setKind("volume"); setCursorTime(null); }}>Volume</button></div>
    </div>
    <h2 id="profile-history-heading" className="sr-only">Account history</h2>
    {points.length ? <div className={styles.chart}>
      <div className={styles.axis}><span>{numberLabel(chart.max)}</span><span>{numberLabel((chart.max + chart.min) / 2)}</span><span>{numberLabel(chart.min)}</span></div>
      <div ref={plotRef} className={styles.chartPlot} role="slider" tabIndex={0} aria-label={`Inspect ${label.toLowerCase()} history`} aria-valuemin={visible.start} aria-valuemax={visible.end} aria-valuenow={Math.round(inspectedTime ?? visible.end)} aria-valuetext={inspected ? `${numberLabel(inspected.value)} feathers at ${formatLocalTime(new Date(inspectedTime!), "short")}` : `${numberLabel(current)} feathers now`} aria-describedby={inspected ? tooltipId : undefined} onPointerMove={inspectPointer} onPointerLeave={() => setCursorTime(null)} onKeyDown={inspectKeyboard} onBlur={() => setCursorTime(null)}>
        <svg viewBox="0 0 720 246" role="img" aria-label={`${label} over time, currently ${numberLabel(current)} feathers`} preserveAspectRatio="none"><defs><linearGradient id={`profile-${kind}-fill`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".22"/><stop offset="1" stopColor="currentColor" stopOpacity="0"/></linearGradient></defs><path className={styles.area} d={chart.area} fill={`url(#profile-${kind}-fill)`}/><path className={styles.line} d={chart.line}/></svg>
        {inspected && <><span className={styles.crosshair} style={{ left: `${cursorX}%` }} aria-hidden="true"/><span className={styles.chartDot} style={{ left: `${cursorX}%`, top: `${cursorY}%` }} aria-hidden="true"/><div id={tooltipId} role="tooltip" className={styles.chartTooltip} style={{ left: `${tooltipX}%` }}><strong><FeatherIcon /> {numberLabel(inspected.value)}</strong><span>{formatLocalTime(new Date(inspectedTime!), "short")}</span>{inspected.timestamp < inspectedTime! && <small>Last changed {formatLocalTime(new Date(inspected.timestamp), "short")}</small>}</div></>}
      </div>
    </div> : <div className={styles.chartEmpty}><BarChart3 /><span>No {kind} history yet</span></div>}
    <div className={`${styles.segmented} ${styles.rangeTabs}`} style={rangeStyle} role="group" aria-label="Chart range"><span className={styles.segmentIndicator} aria-hidden="true"/>{(["1D", "1W", "1M", "ALL"] as const).map((value) => <button key={value} type="button" aria-pressed={range === value} onClick={() => { setRange(value); setCursorTime(null); }}>{value}</button>)}</div>
  </section>;
}

export function PublicProfileDashboard(props: PublicProfileDashboardProps) {
  const [tab, setTab] = useState<"positions" | "activity">("positions");
  const [tabDirection, setTabDirection] = useState<1 | -1>(1);
  const [positionFilter, setPositionFilter] = useState<"active" | "all">("active");
  const [query, setQuery] = useState("");
  const positions = props.positions.filter((position) => (positionFilter === "all" || ["OPEN", "PAUSED", "RESOLVING", "CLOSED"].includes(position.marketStatus)) && position.marketTitle.toLowerCase().includes(query.toLowerCase()));

  return <div className={styles.dashboard}>
    <div className={styles.overview}>
      <section className={styles.identityCard} aria-labelledby="profile-name">
        <div className={styles.identity}><div className={styles.avatar} aria-hidden="true">{initials(props.identity.displayName)}</div><div><h1 id="profile-name">{props.identity.displayName}</h1><p><UserProfileLink username={props.identity.username}>@{props.identity.username}</UserProfileLink></p></div></div>
        {props.identity.bio && <p className={styles.bio}>{props.identity.bio}</p>}
        <p className={styles.joined}><CalendarDays /> Joined <LocalTime value={props.identity.joinedAt} preset="month-year" /></p>
        <dl className={styles.metrics}>
          <div><dt>Portfolio value</dt><dd><FeatherIcon /> {props.summary.equity}</dd></div>
          <div><dt>Profit / loss</dt><dd className={props.summary.pnlPositive ? styles.positive : styles.negative}>{props.summary.pnlPositive ? "+" : "−"}<FeatherIcon /> {props.summary.pnl}</dd></div>
          <div><dt>Volume</dt><dd><FeatherIcon /> {props.summary.volume}</dd></div>
          <div><dt>Predictions</dt><dd>{props.summary.trades.toLocaleString("en-CA")}</dd></div>
          <div><dt>Markets</dt><dd>{props.summary.marketsTraded.toLocaleString("en-CA")}</dd></div>
        </dl>
        <details className={styles.breakdown}><summary>Portfolio breakdown</summary><dl><div><dt>Available</dt><dd><FeatherIcon /> {props.summary.availableCash}</dd></div><div><dt>Reserved</dt><dd><FeatherIcon /> {props.summary.reservedCash}</dd></div><div><dt>Positions</dt><dd><FeatherIcon /> {props.summary.positionValue}</dd></div></dl></details>
      </section>
      <HistoryChart balanceSeries={props.balanceSeries} volumeSeries={props.volumeSeries} asOf={props.asOf} />
    </div>

    <section className={styles.records}>
      <div className={styles.tabs} role="tablist" aria-label="Profile records" style={{ "--segment-index": tab === "positions" ? 0 : 1 } as CSSProperties}><span className={styles.tabIndicator} aria-hidden="true"/><button type="button" role="tab" aria-selected={tab === "positions"} onClick={() => { setTabDirection(-1); setTab("positions"); }}><WalletCards /> Positions <span>{props.positions.length}</span></button><button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => { setTabDirection(1); setTab("activity"); }}><Activity /> Activity <span>{props.recentTrades.length}</span></button></div>
      <div key={tab} className={`${styles.tabPanel} ${tabDirection < 0 ? styles.tabPanelBack : ""}`} role="tabpanel">
      {tab === "positions" ? <>
        <div className={styles.toolbar}><div className={styles.filters} role="group" aria-label="Position status"><button type="button" aria-pressed={positionFilter === "active"} onClick={() => setPositionFilter("active")}>Active</button><button type="button" aria-pressed={positionFilter === "all"} onClick={() => setPositionFilter("all")}>All</button></div><label className={styles.search}><Search /><span className="sr-only">Search positions</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search positions" /></label></div>
        {positions.length ? <div className={styles.positionTable}><div className={styles.tableHeader}><span>Market</span><span>Contracts</span><span>Avg.</span><span>Forecast</span><span>Value</span><span>P/L</span></div>{positions.map((position) => <Link key={position.id} className={styles.positionRow} href={`/markets/${encodeURIComponent(position.marketSlug)}?outcome=${position.side}`}><span className={styles.marketCell}><b className={position.side === "YES" ? styles.yes : styles.no}>{position.side}</b><span><strong>{position.marketTitle}</strong><small>{position.marketStatus.toLowerCase().replaceAll("_", " ")}</small></span></span><span data-label="Contracts">{position.quantity.toLocaleString("en-CA")}</span><span data-label="Average">{Math.round(position.averagePrice)}%</span><span data-label="Forecast">{position.probability === null ? "—" : `${Math.round(position.probability)}%`}</span><span data-label="Value"><FeatherIcon /> {position.value}</span><span data-label="P/L" className={position.pnlPositive ? styles.positive : styles.negative}>{position.pnlPositive ? "+" : "−"}<FeatherIcon /> {position.pnl}</span></Link>)}</div> : <EmptyState title={query ? "No matching positions" : "No positions yet"} description={query ? "Try another market name." : "This account has no positions to show."} />}
      </> : props.recentTrades.length ? <div className={styles.activityList}>{props.recentTrades.map((trade) => <Link className={styles.activityRow} href={`/markets/${encodeURIComponent(trade.marketSlug)}?outcome=${trade.side}`} key={trade.id}><span className={trade.side === "YES" ? styles.yesDot : styles.noDot}/><span><strong>{trade.marketTitle}</strong><small>{trade.action.toLowerCase()} {trade.quantity.toLocaleString("en-CA")} {trade.side} · {trade.source === "ORDER_BOOK" ? "Order book" : "Market maker"}</small></span><b><FeatherIcon /> {trade.amount}</b><LocalTime value={trade.createdAt} /></Link>)}</div> : <EmptyState title="No trades yet" description="Recent executions will appear here." />}
      </div>
    </section>
  </div>;
}
