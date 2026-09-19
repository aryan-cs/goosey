type PlotPoint = { x: number; y: number };

/** A shape-preserving cubic curve through the observations, without new extrema. */
export function smoothChartPath(points: readonly PlotPoint[]): string {
  if (!points.length) return "";
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
  return path;
}
