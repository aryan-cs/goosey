import { normalizeChartPoints, type ChartPoint } from "./chart-series";

// Event-day boundary already used by Goosey's Hack the North event catalog.
// The public event dates do not establish a precise opening-ceremony hour.
export const HACK_THE_NORTH_CHART_START = Date.parse("2026-09-18T00:00:00-04:00");

export type OpeningBaseline = { probability: number; until: number };

/** Display-only opening-price hold. Never creates trades or persisted snapshots. */
export function withOpeningBaseline(points: readonly ChartPoint[], opening: OpeningBaseline | undefined, now: number): ChartPoint[] {
  const series = normalizeChartPoints(points);
  if (!opening || !Number.isFinite(opening.probability) || opening.probability < 0 || opening.probability > 1
    || !Number.isFinite(opening.until) || now < HACK_THE_NORTH_CHART_START) return series;
  const start = HACK_THE_NORTH_CHART_START;
  // Keep existing pre-event history intact.
  if (series[0] && series[0].timestamp <= start) return series;
  const firstChange = series.find(point => point.probability !== opening.probability);
  const end = Math.min(opening.until - 1, now, (firstChange?.timestamp ?? Infinity) - 1);
  if (end < start) return series;
  return normalizeChartPoints([
    { timestamp: start, probability: opening.probability, opening: true },
    ...(end > start ? [{ timestamp: end, probability: opening.probability, opening: true as const }] : []),
    ...series,
  ]);
}
