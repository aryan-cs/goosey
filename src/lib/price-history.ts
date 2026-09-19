export interface PriceHistoryPoint {
  timestamp: Date;
  probabilityYesBps: number;
}

/**
 * Produces a real chronological series from persisted snapshots. If the latest
 * persisted point predates a state change, append the authoritative current
 * state at the market update time; no intermediate points are synthesized.
 */
export function chronologicalPriceHistory(
  snapshots: readonly PriceHistoryPoint[],
  currentProbabilityYesBps: number,
  currentAt: Date,
): PriceHistoryPoint[] {
  const history = snapshots
    .map((point) => ({ ...point }))
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const latest = history.at(-1);
  if (!latest || latest.probabilityYesBps !== currentProbabilityYesBps) {
    history.push({ timestamp: currentAt, probabilityYesBps: currentProbabilityYesBps });
  }
  return history;
}

/**
 * Bounds a chronological response without turning a volatile series into a
 * flat line. Endpoints are always retained and each time bucket contributes
 * its local low/high in chronological order.
 */
export function boundedPriceHistory<T extends PriceHistoryPoint>(
  points: readonly T[],
  limit: number,
): T[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("History limit must be a positive integer.");
  const ordered = [...points].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  if (ordered.length <= limit) return ordered;
  if (limit === 1) return [ordered.at(-1)!];
  if (limit === 2) return [ordered[0]!, ordered.at(-1)!];

  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const interior = ordered.slice(1, -1);
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const selected = new Set<T>([first, last]);
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor((bucket * interior.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * interior.length) / bucketCount);
    const values = interior.slice(start, end);
    if (!values.length) continue;
    let low = values[0]!;
    let high = values[0]!;
    for (const point of values.slice(1)) {
      if (point.probabilityYesBps < low.probabilityYesBps) low = point;
      if (point.probabilityYesBps > high.probabilityYesBps) high = point;
    }
    selected.add(low);
    selected.add(high);
  }

  if (selected.size < limit) {
    const firstAt = first.timestamp.getTime();
    const duration = Math.max(1, last.timestamp.getTime() - firstAt);
    const delta = last.probabilityYesBps - first.probabilityYesBps;
    const remaining = interior
      .filter((point) => !selected.has(point))
      .sort((left, right) => {
        const deviation = (point: T) => {
          const progress = (point.timestamp.getTime() - firstAt) / duration;
          return Math.abs(point.probabilityYesBps - (first.probabilityYesBps + delta * progress));
        };
        return deviation(right) - deviation(left) || left.timestamp.getTime() - right.timestamp.getTime();
      });
    for (const point of remaining) {
      if (selected.size >= limit) break;
      selected.add(point);
    }
  }
  return [...selected]
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())
    .slice(0, limit);
}
