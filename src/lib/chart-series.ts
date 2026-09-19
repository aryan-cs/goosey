export interface ChartPoint {
  timestamp: string | number | Date;
  probability: number;
  opening?: boolean;
  held?: boolean;
}

export interface NormalizedChartPoint {
  timestamp: number;
  probability: number;
  opening?: boolean;
  held?: boolean;
}

export const CHART_RANGES = ["1H", "4H", "8H", "24H", "ALL"] as const;
export type ChartRange = typeof CHART_RANGES[number];
export const CHART_RANGE_DURATION = { "1H": 3_600_000, "4H": 14_400_000, "8H": 28_800_000, "24H": 86_400_000 } as const;

/** Retain only real, valid observations; the last input wins timestamp ties. */
export function normalizeChartPoints(points: readonly ChartPoint[]): NormalizedChartPoint[] {
  const byTime = new Map<number, NormalizedChartPoint>();
  for (const point of points) {
    const timestamp = new Date(point.timestamp).getTime();
    if (!Number.isFinite(timestamp) || !Number.isFinite(point.probability)
      || point.probability < 0 || point.probability > 1) continue;
    byTime.set(timestamp, { timestamp, probability: point.probability, ...(point.opening ? { opening: true } : {}), ...(point.held ? { held: true } : {}) });
  }
  return [...byTime.values()].sort((left, right) => left.timestamp - right.timestamp);
}

/** Display-only endpoint for the last known price; never a new observation. */
export function withHeldPriceEndpoint(points: readonly ChartPoint[], now: number): NormalizedChartPoint[] {
  const series = normalizeChartPoints(points).filter(point => !point.held);
  const latest = series.at(-1);
  if (!latest || !Number.isFinite(now) || now <= latest.timestamp) return series;
  return [...series, { timestamp: now, probability: latest.probability, held: true }];
}

/** Keep small moves readable, with an explicitly labeled probability domain. */
export function chartDomain(points: readonly ChartPoint[]): [number, number] {
  const normalized = normalizeChartPoints(points);
  if (!normalized.length) return [0, 1];
  let low = 1;
  let high = 0;
  for (const point of normalized) {
    low = Math.min(low, point.probability);
    high = Math.max(high, point.probability);
  }
  const span = Math.min(1, Math.max(0.1, high - low + 0.04));
  const start = Math.max(0, Math.min(1 - span, (low + high - span) / 2));
  return [start, Math.min(1, start + span)];
}

/** Returns an index into sorted, normalized observations; earlier wins exact ties. */
export function nearestChartIndex(points: readonly NormalizedChartPoint[], targetTimestamp: number): number {
  if (!points.length || !Number.isFinite(targetTimestamp)) return -1;
  let start = 0;
  let end = points.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (points[middle].timestamp < targetTimestamp) start = middle + 1;
    else end = middle;
  }
  if (start === 0) return 0;
  if (start === points.length) return points.length - 1;
  return targetTimestamp - points[start - 1].timestamp <= points[start].timestamp - targetTimestamp ? start - 1 : start;
}

/** Include the actual last observation before the window as its held-price baseline. */
export function selectChartRange(points: readonly ChartPoint[], range: ChartRange, now: number): NormalizedChartPoint[] {
  const normalized = normalizeChartPoints(points);
  if (range === "ALL") return normalized;
  if (!Number.isFinite(now)) return [];
  const cutoff = now - CHART_RANGE_DURATION[range];
  const selected: NormalizedChartPoint[] = [];
  let baseline: NormalizedChartPoint | undefined;
  for (const point of normalized) {
    if (point.timestamp < cutoff) baseline = point;
    else if (point.timestamp <= now) selected.push(point);
  }
  return baseline ? [baseline, ...selected] : selected;
}
