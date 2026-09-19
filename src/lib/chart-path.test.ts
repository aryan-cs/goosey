import { describe, expect, it } from "vitest";
import { createChartCurve, smoothChartPath } from "./chart-path";

describe("smoothChartPath", () => {
  it("handles empty, single and coincident observations without invalid coordinates", () => {
    expect(smoothChartPath([])).toBe("");
    expect(smoothChartPath([{ x: 0, y: 50 }])).toBe("M 0 50");
    expect(smoothChartPath([{ x: 0, y: 20 }, { x: 0, y: 80 }])).toBe("M 0 20 L 0 80");
  });

  it("passes through every observation without overshoot on irregular intervals", () => {
    const points = [{ x: 0, y: 0 }, { x: .01, y: 100 }, { x: 30, y: 80 }, { x: 31, y: 80 }, { x: 90, y: 40 }, { x: 100, y: 100 }];
    const curves = smoothChartPath(points).split(" C ").slice(1).map(segment => segment.split(" ").map(Number));
    expect(curves).toHaveLength(points.length - 1);
    curves.forEach(([x1, y1, x2, y2, x3, y3], i) => {
      const start = points[i], end = points[i + 1];
      expect([x3, y3]).toEqual([end.x, end.y]);
      for (let step = 0; step <= 100; step++) {
        const t = step / 100, u = 1 - t;
        const x = u ** 3 * start.x + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3;
        const y = u ** 3 * start.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3;
        expect(x).toBeGreaterThanOrEqual(start.x - 1e-9);
        expect(x).toBeLessThanOrEqual(end.x + 1e-9);
        expect(y).toBeGreaterThanOrEqual(Math.min(start.y, end.y) - 1e-9);
        expect(y).toBeLessThanOrEqual(Math.max(start.y, end.y) + 1e-9);
      }
      if (i > 0) {
        const previous = curves[i - 1];
        expect((start.y - previous[3]) / (start.x - previous[2])).toBeCloseTo((y1 - start.y) / (x1 - start.x));
      }
    });
  });
});


describe("createChartCurve inspection", () => {
  it("has no value for empty history and holds a single observation at every time", () => {
    const empty = createChartCurve([]);
    expect(empty.path).toBe("");
    for (const x of [-100, 0, 50, 100, 200]) expect(empty.valueAt(x)).toBeNull();
    const single = createChartCurve([{ x: 40, y: 73 }]);
    expect(single.path).toBe("M 40 73");
    for (const x of [-100, 0, 40, 50, 100, 200]) expect(single.valueAt(x)).toBe(73);
  });

  it("follows the curved segment rather than linearly interpolating its endpoints", () => {
    const curve = createChartCurve([{ x: 0, y: 0 }, { x: 100, y: 100 }]);
    expect(curve.valueAt(0)).toBe(0);
    expect(curve.valueAt(25)).toBeCloseTo(15.625, 10);
    expect(curve.valueAt(50)).toBeCloseTo(50, 10);
    expect(curve.valueAt(75)).toBeCloseTo(84.375, 10);
    expect(curve.valueAt(100)).toBe(100);
    expect(curve.valueAt(-10)).toBe(0);
    expect(curve.valueAt(120)).toBe(100);
  });

  it("matches the emitted SVG cubic at interior points across irregular gaps without overshoot", () => {
    const points = [
      { x: 0, y: 5 }, { x: .01, y: 40 }, { x: 17, y: 70 },
      { x: 18, y: 100 }, { x: 63, y: 0 }, { x: 99.9, y: 55 }, { x: 100, y: 55 },
    ];
    const curve = createChartCurve(points);
    const segments = curve.path.split(" C ").slice(1).map(segment => segment.split(" ").map(Number));
    expect(segments).toHaveLength(points.length - 1);
    expect(curve.path).toBe(smoothChartPath(points));
    // De Casteljau evaluation from actual SVG controls is independent of the
    // evaluator's tangent calculation and timestamp-to-segment selection.
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    const cubic = (a: number, b: number, c: number, d: number, t: number) =>
      mix(mix(mix(a, b, t), mix(b, c, t), t), mix(mix(b, c, t), mix(c, d, t), t), t);
    segments.forEach(([x1, y1, x2, y2, x3, y3], i) => {
      const start = points[i], end = points[i + 1];
      expect(curve.valueAt(start.x)).toBeCloseTo(start.y, 9);
      expect(curve.valueAt(end.x)).toBeCloseTo(end.y, 9);
      for (const t of [.001, .1, .25, .5, .75, .9, .999]) {
        const x = cubic(start.x, x1, x2, x3, t);
        const expectedY = cubic(start.y, y1, y2, y3, t);
        const inspectedY = curve.valueAt(x)!;
        expect(inspectedY).toBeCloseTo(expectedY, 8);
        expect(inspectedY).toBeGreaterThanOrEqual(Math.min(start.y, end.y) - 1e-9);
        expect(inspectedY).toBeLessThanOrEqual(Math.max(start.y, end.y) + 1e-9);
      }
    });
  });

  it("preserves the opening plateau, flat gaps, and trailing hold", () => {
    const curve = createChartCurve([
      { x: 0, y: 50 }, { x: 39.999, y: 50 }, { x: 40, y: 80 },
      { x: 60, y: 80 }, { x: 75, y: 30 },
    ]);
    for (const x of [0, 1, 20, 39, 39.999]) expect(curve.valueAt(x)).toBeCloseTo(50, 10);
    for (const x of [40, 40.001, 50, 59.999, 60]) expect(curve.valueAt(x)).toBeCloseTo(80, 10);
    for (const x of [75, 76, 100, 1000]) expect(curve.valueAt(x)).toBe(30);
  });

  it("selects the later observation at coincident boundary and interior coordinates", () => {
    const curve = createChartCurve([
      { x: 0, y: 20 }, { x: 0, y: 70 }, { x: 40, y: 80 },
      { x: 40, y: 30 }, { x: 100, y: 10 }, { x: 100, y: 60 },
    ]);
    expect(curve.path).toContain("M 0 20 L 0 70");
    expect(curve.valueAt(0)).toBe(70);
    expect(curve.valueAt(40)).toBe(30);
    expect(curve.valueAt(100)).toBe(60);
    expect(curve.valueAt(110)).toBe(60);
    expect(curve.valueAt(0.001)).toBeCloseTo(70, 5);
    expect(curve.valueAt(39.999)).toBeCloseTo(80, 5);
    expect(curve.valueAt(40.001)).toBeCloseTo(30, 5);
    expect(curve.valueAt(99.999)).toBeCloseTo(10, 5);
  });

  it("evaluates a pre-window baseline using the same clamped coordinates as the path", () => {
    const observations = [{ x: -40, y: 20 }, { x: 10, y: 60 }, { x: 100, y: 80 }];
    const plotted = createChartCurve(observations.map(point => ({ ...point, x: Math.max(0, point.x) })));
    expect(plotted.valueAt(0)).toBe(20);
    expect(plotted.valueAt(5)).toBeCloseTo(39.7222222222, 8);
    expect(plotted.valueAt(5)).not.toBeCloseTo(createChartCurve(observations).valueAt(5)!, 2);
    const stacked = createChartCurve([{ x: 0, y: 20 }, { x: 0, y: 60 }, { x: 0, y: 80 }]);
    expect(stacked.valueAt(0)).toBe(80);
    expect(stacked.valueAt(1)).toBe(80);
  });
});
