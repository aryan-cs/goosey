type PlotPoint = { x: number; y: number };

/**
 * A step-after market-price path. A committed price remains authoritative until
 * the next observation; the graph and inspector never invent prices between
 * trades. Coincident coordinates select the later observation.
 */
export function createChartCurve(points: readonly PlotPoint[]): {
  path: string;
  valueAt: (x: number) => number | null;
} {
  if (!points.length) return { path: "", valueAt: () => null };
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const point = points[i];
    path += ` H ${point.x} V ${point.y}`;
  }
  function valueAt(x: number): number {
    if (x < points[0].x) return points[0].y;
    let left = 0,
      right = points.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (points[middle].x <= x) left = middle + 1;
      else right = middle;
    }
    return points[Math.max(0, left - 1)].y;
  }
  return { path, valueAt };
}

/** Kept as the public path helper for existing callers; output is step-after. */
export function smoothChartPath(points: readonly PlotPoint[]): string {
  return createChartCurve(points).path;
}
