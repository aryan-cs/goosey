import { describe, expect, it } from "vitest";
import { smoothChartPath } from "./chart-path";

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
