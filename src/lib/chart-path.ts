type PlotPoint = { x: number; y: number };

/** A shape-preserving cubic curve through the observations, without new extrema. */
export function createChartCurve(points: readonly PlotPoint[]): { path: string; valueAt: (x: number) => number | null } {
  if (!points.length) return { path: "", valueAt: () => null };
  const slopes = points.slice(1).map((point, i) => {
    const previous = points[i];
    return point.x > previous.x ? (point.y - previous.y) / (point.x - previous.x) : 0;
  });
  const tangents = points.map((_, i) => {
    // Level endpoints also join the chart's trailing horizontal hold smoothly.
    if (i === 0 || i === points.length - 1) return 0;
    const before = slopes[i - 1];
    const after = slopes[i];
    if (before * after <= 0) return 0;
    // Limiting both handles to the adjacent secants keeps every Bézier control
    // point inside its segment's price range, even with irregular timestamps.
    return Math.sign(before) * Math.min(Math.abs(before), Math.abs(after));
  });
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const point = points[i];
    const third = (point.x - previous.x) / 3;
    if (third <= 0) {
      path += ` L ${point.x} ${point.y}`;
    } else {
      path += ` C ${previous.x + third} ${previous.y + tangents[i - 1] * third} ${point.x - third} ${point.y - tangents[i] * third} ${point.x} ${point.y}`;
    }
  }
  function valueAt(x: number): number {
    if (x < points[0].x) return points[0].y;
    // Upper bound ensures coincident x coordinates select the later observation.
    let left = 0, right = points.length;
    while (left < right) {
      const middle = (left + right) >>> 1;
      if (points[middle].x <= x) left = middle + 1;
      else right = middle;
    }
    if (left === points.length) return points.at(-1)!.y;
    const i = Math.max(0, left - 1);
    const start = points[i], end = points[i + 1];
    const span = end.x - start.x;
    if (span <= 0) return end.y;
    const t = (x - start.x) / span, u = 1 - t;
    return u ** 3 * start.y + 3 * u ** 2 * t * (start.y + tangents[i] * span / 3)
      + 3 * u * t ** 2 * (end.y - tangents[i + 1] * span / 3) + t ** 3 * end.y;
  }
  return { path, valueAt };
}

export function smoothChartPath(points: readonly PlotPoint[]): string {
  return createChartCurve(points).path;
}
