"use client";
import { withOpeningBaseline, type OpeningBaseline } from "@/lib/chart-opening";
import styles from "./probability-plot.module.css";
import rangeStyles from "./chart-range.module.css";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CHART_RANGES, CHART_RANGE_DURATION, type ChartRange, chartDomain, withHeldPriceEndpoint, normalizeChartPoints, selectChartRange, type ChartPoint } from "@/lib/chart-series";
import { createChartCurve } from "@/lib/chart-path";
import { probabilityFractionLabel, probabilityFractionToBps, probabilityMovementPoints } from "@/lib/probability-format";

type ChartInspection = { timestamp: number; probability: number; opening?: boolean; held?: boolean };

export function probabilityLabel(value: number) {
  return probabilityFractionLabel(value);
}

function dateLabel(timestamp: number) {
  return new Date(timestamp).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

export function ProbabilityPlot({ points, compact = false, positive = true, startAt, endAt, label = "YES probability", emptyLabel = "No probability history yet", onInspect }: {
  points: ChartPoint[]; compact?: boolean; positive?: boolean; startAt?: number; endAt?: number; label?: string; emptyLabel?: string;
  onInspect?: (point: ChartInspection | null) => void;
}) {
  const series = useMemo(() => normalizeChartPoints(points), [points]);
  const inspectionToken = useMemo(() => ({ endAt, series }), [endAt, series]);
  const [inspection, setInspection] = useState<{ time: number | null; token: object }>(() => ({ time: null, token: inspectionToken }));
  const inspectedTime = inspection.token === inspectionToken ? inspection.time : null;
  const interaction = useRef<"pointer" | "keyboard">("pointer");
  const gradient = useId().replace(/:/g, "");
  const [low, high] = compact ? chartDomain(series) : [0, 1];
  const firstTime = startAt ?? series[0]?.timestamp ?? 0;
  const lastTime = Math.max(endAt ?? series.at(-1)?.timestamp ?? firstTime, firstTime + 1);
  const inspectionStart = Math.max(firstTime, series[0]?.timestamp ?? firstTime);
  const clampTime = (time: number) => Math.max(inspectionStart, Math.min(lastTime, time));
  const selectedTime = inspectedTime === null ? lastTime : clampTime(inspectedTime);
  const x = (time: number) => Math.max(0, Math.min(100, (time - firstTime) / (lastTime - firstTime) * 100));
  const y = (probability: number) => 100 - (probability - low) / (high - low) * 100;
  const geometry = useMemo(() => createChartCurve(series.filter(point => !point.held).map(point => ({
    x: Math.max(0, Math.min(100, (point.timestamp - firstTime) / (lastTime - firstTime) * 100)),
    y: 100 - (point.probability - low) / (high - low) * 100,
  }))), [series, firstTime, lastTime, low, high]);
  function sample(timestamp: number): ChartInspection {
    const lastObservation = series.at(-1)?.held ? series.at(-2) : series.at(-1);
    const exact = series.find(point => point.timestamp === timestamp);
    if (exact) return exact;
    const nextIndex = series.findIndex(point => point.timestamp > timestamp);
    const previous = series[nextIndex < 0 ? series.length - 1 : Math.max(0, nextIndex - 1)];
    const next = nextIndex < 0 ? undefined : series[nextIndex];
    const held = lastObservation && timestamp > lastObservation.timestamp;
    const opening = previous?.opening && (!next || next.opening || previous.probability === next.probability);
    return { timestamp, probability: Math.max(0, Math.min(1, low + (100 - (geometry.valueAt(x(timestamp)) ?? 50)) / 100 * (high - low))),
      ...(held ? { held: true } : opening ? { opening: true } : {}) };
  }
  const selected = series.length ? sample(selectedTime) : undefined;
  function inspect(timestamp: number | null) {
    const time = timestamp === null ? null : clampTime(timestamp);
    setInspection({ time, token: inspectionToken });
    onInspect?.(time === null ? null : sample(time));
  }
  function pointer(clientX: number, bounds: DOMRect) {
    if (!bounds.width) return;
    const ratio = Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
    const time = firstTime + ratio * (lastTime - firstTime);
    inspect(time);
  }
  if (!series.length || !selected) return <div className="probability-empty">{emptyLabel}</div>;
  const path = geometry.path + ` H 100`;
  const selectedX = x(selected.timestamp);
  return <div className={`probability-plot ${compact ? "compact-plot" : "full-plot"} ${positive ? "positive" : "negative"}`}>
    <div className="probability-plot-surface" role="slider" tabIndex={0} aria-label={`${label} history`} aria-valuemin={inspectionStart} aria-valuemax={lastTime} aria-valuenow={selectedTime} aria-valuetext={`${probabilityLabel(selected.probability)} on ${dateLabel(selected.timestamp)}${selected.held ? ", held price" : selected.opening ? ", opening price" : ""}`} data-inspecting={inspectedTime !== null}
      onPointerMove={(event) => { if (event.pointerType !== "touch" || event.buttons) { interaction.current = "pointer"; pointer(event.clientX, event.currentTarget.getBoundingClientRect()); } }}
      onPointerDown={(event) => { interaction.current = "pointer"; if (event.pointerType === "touch") event.currentTarget.setPointerCapture(event.pointerId); pointer(event.clientX, event.currentTarget.getBoundingClientRect()); }}
      onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); if (event.pointerType !== "mouse") inspect(null); }}
      onPointerCancel={() => inspect(null)} onPointerLeave={() => { if (interaction.current === "pointer") inspect(null); }} onBlur={() => inspect(null)}
      onKeyDown={(event) => {
        const selectedTimestamp = selectedTime;
        const target = event.key === "Home" ? inspectionStart : event.key === "End" ? lastTime : ["ArrowLeft", "ArrowDown"].includes(event.key) ? Math.max(inspectionStart, selectedTimestamp - 10 * 60_000) : ["ArrowRight", "ArrowUp"].includes(event.key) ? Math.min(lastTime, selectedTimestamp + 10 * 60_000) : null;
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
      <span className="probability-tooltip" style={{ left: `clamp(0px, ${selectedX}% - 110px, max(0px, 100% - 220px))` }} role="tooltip" aria-hidden={inspectedTime === null}>
        <time dateTime={new Date(selected.timestamp).toISOString()}>{dateLabel(selected.timestamp)}</time>
        <strong><i />{selected.opening ? "Opening price" : label === "YES probability" || label === "YES execution price" ? "Yes" : label}<b>{probabilityLabel(selected.probability)}</b></strong>
      </span>
      {!compact && <span className="probability-point-label" style={{ left: `clamp(0px, ${selectedX}% + 10px, max(0px, 100% - 120px))`, top: `${y(selected.probability)}%` }} aria-hidden="true">YES {probabilityLabel(selected.probability)}</span>}
    </div>
    {!compact && <div className="probability-time-axis"><time>{dateLabel(firstTime)}</time><time>{dateLabel(lastTime)}</time></div>}
  </div>;
}

export function ProbabilityChart({ points, label = "YES probability", height = 300, asOf, marketSlug, executionPrices = false, openingBaseline }: { points: ChartPoint[]; label?: string; height?: number; asOf?: number; marketSlug?: string; executionPrices?: boolean; openingBaseline?: OpeningBaseline }) {
  const [range, setRange] = useState<ChartRange>("1H");
  const [inspected, setInspected] = useState<ChartInspection | null>(null);
  // The first client render must use the same domain as the server render.
  // After hydration, advance the domain even when there are no new observations.
  const [clock, setClock] = useState(() => asOf ?? Math.max(0, ...normalizeChartPoints(points).map(point => point.timestamp)));
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const advance = () => {
      if (document.visibilityState !== "visible") return;
      setInspected(null);
      if (marketSlug) setRetry(value => value + 1);
    };
    const timer = window.setInterval(advance, 10 * 60 * 1000);
    document.addEventListener("visibilitychange", advance);
    window.addEventListener("focus", advance);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", advance);
      window.removeEventListener("focus", advance);
    };
  }, [marketSlug]);
  const [history, setHistory] = useState<{ range: string; slug: string; points: ChartPoint[] } | null>(null);
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    if (!marketSlug) return;
    const controller = new AbortController();
    fetch(`/api/markets/${encodeURIComponent(marketSlug)}/history?range=${range}&limit=2000`, { signal: controller.signal, cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("History unavailable");
        const body = await response.json() as { asOf: string; snapshots: { createdAt: string; yesProbabilityBps: number }[] };
        setHistory({ range, slug: marketSlug, points: body.snapshots.map(point => ({ timestamp: point.createdAt, probability: point.yesProbabilityBps / 10000 })) });
        const serverTime = Date.parse(body.asOf);
        if (!Number.isFinite(serverTime)) throw new Error("History timestamp unavailable");
        setClock(serverTime);
        setInspected(null);
        setHistoryError(false);
      }).catch(error => { if (error.name !== "AbortError") setHistoryError(true); });
    return () => controller.abort();
  }, [marketSlug, points, retry, range]);
  const observations = history?.range === range && history.slug === marketSlug ? history.points : points;
  const now = Math.max(clock, ...normalizeChartPoints(observations).map(point => point.timestamp));
  const series = useMemo(() => withHeldPriceEndpoint(selectChartRange(withOpeningBaseline(observations, openingBaseline, now), range, now), now), [observations, openingBaseline, range, now]);
  const latest = series.at(-1);
  const selected: ChartInspection | undefined = inspected ?? latest;
  const change = latest && series[0] ? probabilityMovementPoints(probabilityFractionToBps(series[0].probability), probabilityFractionToBps(latest.probability)) : null;
  const duration = range === "ALL" ? null : CHART_RANGE_DURATION[range];
  return <figure className={`probability-chart ${styles.chart}`} style={{ minHeight: height }}>
    {historyError && <p className="chart-history-error" role="status">Full history could not load. <button type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></p>}
    <figcaption><div><span className="eyebrow">{selected?.held && inspected ? "Held price" : selected?.opening ? "Opening price" : executionPrices ? inspected ? "Historical execution" : "Last execution" : inspected ? "Historical probability" : "Current forecast"}</span><strong>{selected ? probabilityLabel(selected.probability) : "N/A"}</strong><small className="chart-inspected-time" style={{ visibility: inspected ? "visible" : "hidden" }}>{dateLabel(selected?.timestamp ?? now)}</small></div>
      <span style={{ visibility: change === null ? "hidden" : "visible" }} className={`chart-change ${change !== null && change < 0 ? "movement-down" : change !== null && change > 0 ? "movement-up" : ""}`}>{change !== null && change > 0 ? "+" : ""}{change ?? 0} pts <small>in this period</small></span>
    </figcaption>
    <ProbabilityPlot points={series} label={label} emptyLabel={executionPrices ? "No executions yet" : "No probability history yet"} startAt={duration === null ? undefined : now - duration} endAt={now} onInspect={setInspected} />
    <div className="probability-chart-footer"><div className={`range-tabs ${rangeStyles.ranges}`} aria-label="Chart range">{CHART_RANGES.map(value => <button key={value} type="button" aria-pressed={value === range} className={value === range ? "active" : ""} onClick={() => { setInspected(null); setRange(value); }}>{value}</button>)}</div></div>
  </figure>;
}
