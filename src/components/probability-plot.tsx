"use client";
import { withOpeningBaseline, type OpeningBaseline } from "@/lib/chart-opening";
import rangeStyles from "./chart-range.module.css";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CHART_RANGES, CHART_RANGE_DURATION, type ChartRange, chartDomain, nearestChartIndex, normalizeChartPoints, selectChartRange, type ChartPoint } from "@/lib/chart-series";
import { smoothChartPath } from "@/lib/chart-path";

export function probabilityLabel(value: number) {
  return `${Math.round(value * 100)}%`;
}

function dateLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", timeZone: "America/Toronto" });
}

export function ProbabilityPlot({ points, compact = false, positive = true, startAt, endAt, label = "YES probability", emptyLabel = "No probability history yet", onInspect }: {
  points: ChartPoint[]; compact?: boolean; positive?: boolean; startAt?: number; endAt?: number; label?: string; emptyLabel?: string;
  onInspect?: (point: { timestamp: number; probability: number; opening?: boolean } | null) => void;
}) {
  const series = useMemo(() => normalizeChartPoints(points), [points]);
  const [index, setIndex] = useState<number | null>(null);
  const interaction = useRef<"pointer" | "keyboard">("pointer");
  const gradient = useId().replace(/:/g, "");
  const [low, high] = chartDomain(series);
  const firstTime = startAt ?? series[0]?.timestamp ?? 0;
  const lastTime = Math.max(endAt ?? series.at(-1)?.timestamp ?? firstTime, firstTime + 1);
  const x = (time: number) => Math.max(0, Math.min(100, (time - firstTime) / (lastTime - firstTime) * 100));
  const y = (probability: number) => 100 - (probability - low) / (high - low) * 100;
  const activeIndex = index === null ? null : Math.min(index, series.length - 1);
  const selected = series[activeIndex ?? series.length - 1];
  function inspect(next: number | null) { setIndex(next); onInspect?.(next === null ? null : series[next]); }
  function pointer(clientX: number, bounds: DOMRect) {
    if (!bounds.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    inspect(nearestChartIndex(series, firstTime + ratio * (lastTime - firstTime)));
  }
  if (!series.length) return <div className="probability-empty">{emptyLabel}</div>;
  const path = smoothChartPath(series.map(point => ({ x: x(point.timestamp), y: y(point.probability) }))) + ` H 100`;
  const selectedX = x(selected.timestamp);
  return <div className={`probability-plot ${compact ? "compact-plot" : "full-plot"} ${positive ? "positive" : "negative"}`}>
    <div className="probability-plot-surface" role="slider" tabIndex={0} aria-label={`${label} history`} aria-valuemin={0} aria-valuemax={series.length - 1} aria-valuenow={activeIndex ?? series.length - 1} aria-valuetext={`${probabilityLabel(selected.probability)} on ${dateLabel(selected.timestamp)}`} data-inspecting={index !== null}
      onPointerMove={(event) => { if (event.pointerType !== "touch" || event.buttons) { interaction.current = "pointer"; pointer(event.clientX, event.currentTarget.getBoundingClientRect()); } }}
      onPointerDown={(event) => { interaction.current = "pointer"; if (event.pointerType === "touch") event.currentTarget.setPointerCapture(event.pointerId); pointer(event.clientX, event.currentTarget.getBoundingClientRect()); }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (event.pointerType !== "mouse") inspect(null); }}
      onPointerCancel={() => inspect(null)} onPointerLeave={() => { if (interaction.current === "pointer") inspect(null); }} onBlur={() => inspect(null)}
      onKeyDown={(event) => {
        const selectedIndex = activeIndex ?? series.length - 1;
        const target = event.key === "Home" ? 0 : event.key === "End" ? series.length - 1 : ["ArrowLeft", "ArrowDown"].includes(event.key) ? Math.max(0, selectedIndex - 1) : ["ArrowRight", "ArrowUp"].includes(event.key) ? Math.min(series.length - 1, selectedIndex + 1) : null;
        if (event.key === "Escape") { inspect(null); return; }
        if (target !== null) { event.preventDefault(); interaction.current = "keyboard"; inspect(target); }
      }}>
      {!compact && [high, (high + low) / 2, low].map((value, i) => <span key={i} className="probability-tick" style={{ top: `${i * 50}%` }}>{probabilityLabel(value)}</span>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop stopColor="currentColor" stopOpacity=".1" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient><clipPath id={`${gradient}-past`}><rect x="-1" y="-1" width={selectedX + 1} height="102" /></clipPath></defs>
        <g className="probability-series-base">
          <path d={`${path} L 100 100 L ${x(series[0].timestamp)} 100 Z`} fill={`url(#${gradient})`} />
          <path className="probability-line" d={path} fill="none" stroke="currentColor" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
        </g>
        <path className="probability-line probability-series-past" clipPath={`url(#${gradient}-past)`} d={path} fill="none" stroke="currentColor" strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      <span className="probability-crosshair" style={{ left: `${selectedX}%` }} aria-hidden="true" />
      <span className="probability-dot" style={{ left: `${selectedX}%`, top: `${y(selected.probability)}%` }} aria-hidden="true" />
      <span className="probability-tooltip" style={{ left: `clamp(0px, ${selectedX}% - 110px, max(0px, 100% - 220px))` }} role="tooltip" aria-hidden={index === null}>
        <time dateTime={new Date(selected.timestamp).toISOString()}>{dateLabel(selected.timestamp)}</time>
        <strong><i />{selected.opening ? "Opening price" : label === "YES probability" || label === "YES execution price" ? "Yes" : label}<b>{probabilityLabel(selected.probability)}</b></strong>
      </span>
      {!compact && <span className="probability-point-label" style={{ left: `clamp(0px, ${selectedX}% + 10px, max(0px, 100% - 120px))`, top: `${y(selected.probability)}%` }} aria-hidden="true">YES {probabilityLabel(selected.probability)}</span>}
    </div>
    {!compact && <div className="probability-time-axis"><time>{new Date(firstTime).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto", ...(lastTime - firstTime <= 86_400_000 ? { hour: "numeric", minute: "2-digit" } as const : {}) })}</time><time>{new Date(lastTime).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto", ...(lastTime - firstTime <= 86_400_000 ? { hour: "numeric", minute: "2-digit" } as const : {}) })}</time></div>}
  </div>;
}

export function ProbabilityChart({ points, label = "YES probability", height = 300, asOf, marketSlug, executionPrices = false, openingBaseline }: { points: ChartPoint[]; label?: string; height?: number; asOf?: number; marketSlug?: string; executionPrices?: boolean; openingBaseline?: OpeningBaseline }) {
  const [range, setRange] = useState<ChartRange>("ALL");
  const [inspected, setInspected] = useState<{ timestamp: number; probability: number; opening?: boolean } | null>(null);
  // The first client render must use the same domain as the server render.
  // After hydration, advance the domain even when there are no new observations.
  const [clock, setClock] = useState(() => asOf ?? Math.max(0, ...normalizeChartPoints(points).map(point => point.timestamp)));
  useEffect(() => {
    const advance = () => {
      if (document.visibilityState === "visible") setClock(Date.now());
    };
    advance();
    const timer = window.setInterval(advance, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", advance);
    window.addEventListener("focus", advance);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", advance);
      window.removeEventListener("focus", advance);
    };
  }, []);
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<{ range: string; slug: string; points: ChartPoint[] } | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!marketSlug) return;
    const controller = new AbortController();
    fetch(`/api/markets/${encodeURIComponent(marketSlug)}/history?range=${range}&limit=2000`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("History unavailable");
        const body = await response.json() as { snapshots: { createdAt: string; yesProbabilityBps: number }[] };
        setHistory({ range, slug: marketSlug, points: body.snapshots.map(point => ({ timestamp: point.createdAt, probability: point.yesProbabilityBps / 10000 })) });
        setClock(Date.now());
        setInspected(null);
        setRevision(value => value + 1);
        setHistoryError(false);
      }).catch(error => { if (error.name !== "AbortError") setHistoryError(true); });
    return () => controller.abort();
  }, [marketSlug, points, retry, range]);
  const observations = history?.range === range && history.slug === marketSlug ? history.points : points;
  const now = Math.max(clock, ...normalizeChartPoints(observations).map(point => point.timestamp));
  const series = useMemo(() => selectChartRange(withOpeningBaseline(observations, openingBaseline, now), range, now), [observations, openingBaseline, range, now]);
  const latest = series.at(-1);
  const selected = inspected ?? latest;
  const change = latest && series[0] ? (latest.probability - series[0].probability) * 100 : null;
  const duration = range === "ALL" ? null : CHART_RANGE_DURATION[range];
  return <figure className="probability-chart" style={{ minHeight: height }}>
    {historyError && <p className="chart-history-error" role="status">Full history could not load. <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
    <figcaption><div><span className="eyebrow">{selected?.opening ? "Opening price" : executionPrices ? inspected ? "Historical execution" : "Last execution" : inspected ? "Historical probability" : "Current forecast"}</span><strong>{selected ? probabilityLabel(selected.probability) : "N/A"}</strong>{inspected && <small className="chart-inspected-time">{dateLabel(inspected.timestamp)}</small>}</div>
      {change !== null && <span className={`chart-change ${change < 0 ? "movement-down" : change > 0 ? "movement-up" : ""}`}>{change > 0 ? "+" : ""}{Number(change.toFixed(2))} pts <small>in this period</small></span>}
    </figcaption>
    <ProbabilityPlot key={`${range}-${revision}`} points={series} label={label} emptyLabel={executionPrices ? "No executions yet" : "No probability history yet"} startAt={duration === null ? undefined : now - duration} endAt={now} onInspect={setInspected} />
    <div className="probability-chart-footer"><div className={`range-tabs ${rangeStyles.ranges}`} aria-label="Chart range">{CHART_RANGES.map(value => <button key={value} type="button" aria-pressed={value === range} className={value === range ? "active" : ""} onClick={() => { setInspected(null); setRange(value); }}>{value}</button>)}</div></div>
  </figure>;
}
