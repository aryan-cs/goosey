export interface ProfileHistoryPoint {
  timestamp: string | number | Date;
  value: number;
}

export interface NormalizedProfileHistoryPoint {
  timestamp: number;
  value: number;
}

export interface ProfileHistoryPathOptions {
  startAt: number;
  endAt: number;
  width: number;
  height: number;
  minValue: number;
  maxValue: number;
}

/** Retain real finite observations, ordered by time; the last input wins timestamp ties. */
export function normalizeProfileHistory(points: readonly ProfileHistoryPoint[]): NormalizedProfileHistoryPoint[] {
  const byTimestamp = new Map<number, NormalizedProfileHistoryPoint>();
  for (const point of points) {
    const timestamp = new Date(point.timestamp).getTime();
    if (!Number.isFinite(timestamp) || !Number.isFinite(point.value)) continue;
    byTimestamp.set(timestamp, { timestamp, value: point.value });
  }
  return [...byTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

/** Return the most recent actual observation at or before the requested instant. */
export function heldProfileHistoryPoint(
  points: readonly ProfileHistoryPoint[],
  cursorTimestamp: number,
): NormalizedProfileHistoryPoint | null {
  if (!Number.isFinite(cursorTimestamp)) return null;
  const normalized = normalizeProfileHistory(points);
  let start = 0;
  let end = normalized.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (normalized[middle].timestamp <= cursorTimestamp) start = middle + 1;
    else end = middle;
  }
  return start === 0 ? null : normalized[start - 1];
}

/** Include one real pre-window observation as the held baseline, then real in-window events. */
export function selectProfileHistoryRange(
  points: readonly ProfileHistoryPoint[],
  startAt: number,
  endAt: number,
): NormalizedProfileHistoryPoint[] {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return [];
  const normalized = normalizeProfileHistory(points);
  const selected = normalized.filter((point) => point.timestamp >= startAt && point.timestamp <= endAt);
  const baseline = heldProfileHistoryPoint(normalized, startAt);
  if (baseline && baseline.timestamp < startAt) selected.unshift(baseline);
  return selected;
}

function pathNumber(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/**
 * Plot actual timestamps with step-after semantics. Values remain held between
 * observations and through the end of the requested domain; no intermediate
 * monetary observations are invented.
 */
export function profileHistoryStepPath(
  points: readonly ProfileHistoryPoint[],
  options: ProfileHistoryPathOptions,
): string {
  const { startAt, endAt, width, height, minValue, maxValue } = options;
  if (![startAt, endAt, width, height, minValue, maxValue].every(Number.isFinite)
    || endAt <= startAt || width <= 0 || height <= 0 || maxValue < minValue) return "";

  const normalized = normalizeProfileHistory(points);
  const baseline = heldProfileHistoryPoint(normalized, startAt);
  const visible = normalized.filter((point) => point.timestamp >= startAt && point.timestamp <= endAt);
  const plotted: NormalizedProfileHistoryPoint[] = baseline
    ? [{ timestamp: startAt, value: baseline.value }, ...visible.filter((point) => point.timestamp > startAt)]
    : visible;
  if (!plotted.length) return "";

  const valueSpan = maxValue - minValue;
  const x = (timestamp: number) => ((timestamp - startAt) / (endAt - startAt)) * width;
  const y = (value: number) => valueSpan === 0
    ? height / 2
    : height - ((value - minValue) / valueSpan) * height;

  let path = `M${pathNumber(x(plotted[0].timestamp))},${pathNumber(y(plotted[0].value))}`;
  for (const point of plotted.slice(1)) {
    path += ` H${pathNumber(x(point.timestamp))} V${pathNumber(y(point.value))}`;
  }
  const lastTimestamp = plotted.at(-1)!.timestamp;
  if (lastTimestamp < endAt) path += ` H${pathNumber(width)}`;
  return path;
}
