import { describe, expect, it } from "vitest";
import { createChartCurve, smoothChartPath } from "./chart-path";

describe("step-after probability path", () => {
  it("handles empty and single-observation histories", () => {
    expect(smoothChartPath([])).toBe("");
    const single = createChartCurve([{ x: 40, y: 73 }]);
    expect(single.path).toBe("M 40 73");
    for (const x of [-100, 0, 40, 50, 100]) expect(single.valueAt(x)).toBe(73);
  });

  it("holds each real price until the next observation and jumps at its timestamp", () => {
    const curve = createChartCurve([
      { x: 0, y: 50 },
      { x: 30, y: 37.5 },
      { x: 80, y: 51 },
      { x: 100, y: 49 },
    ]);
    expect(curve.path).toBe("M 0 50 H 30 V 37.5 H 80 V 51 H 100 V 49");
    for (const x of [0, 10, 29.999]) expect(curve.valueAt(x)).toBe(50);
    for (const x of [30, 60, 79.999]) expect(curve.valueAt(x)).toBe(37.5);
    for (const x of [80, 99.999]) expect(curve.valueAt(x)).toBe(51);
    for (const x of [100, 120]) expect(curve.valueAt(x)).toBe(49);
  });

  it("selects the last observation at coincident coordinates", () => {
    const curve = createChartCurve([
      { x: 0, y: 20 },
      { x: 0, y: 70 },
      { x: 40, y: 80 },
      { x: 40, y: 30 },
    ]);
    expect(curve.valueAt(0)).toBe(70);
    expect(curve.valueAt(39.999)).toBe(70);
    expect(curve.valueAt(40)).toBe(30);
  });
});
