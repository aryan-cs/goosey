import { describe, expect, it } from "vitest";
import { chartDomain, nearestChartIndex, normalizeChartPoints, selectChartRange, type ChartPoint } from "./chart-series";

const day = 86_400_000;
const now = Date.parse("2026-09-19T12:00:00Z");
const point = (daysAgo: number, probability = 0.5): ChartPoint => ({ timestamp: now - daysAgo * day, probability });

describe("normalizeChartPoints", () => {
  it("handles empty and single-observation histories without inventing records", () => {
    expect(normalizeChartPoints([])).toEqual([]);
    expect(normalizeChartPoints([point(1)])).toEqual([point(1)]);
  });
  it("sorts Date, string, and epoch timestamps and preserves nonuniform timing", () => {
    expect(normalizeChartPoints([
      { timestamp: new Date(now), probability: 1 },
      { timestamp: new Date(now - day).toISOString(), probability: 0 },
      { timestamp: now - 1_000, probability: 0.5001 },
    ])).toEqual([
      { timestamp: now - day, probability: 0 },
      { timestamp: now - 1_000, probability: 0.5001 },
      { timestamp: now, probability: 1 },
    ]);
  });
  it("keeps the last valid input for a duplicate timestamp", () => {
    expect(normalizeChartPoints([point(0, 0.3), point(1), point(0, 0.7), point(0, NaN)]))
      .toEqual([point(1), point(0, 0.7)]);
  });
  it("rejects invalid dates and nonfinite/out-of-range probabilities without clamping", () => {
    expect(normalizeChartPoints([
      { timestamp: "invalid", probability: 0.5 },
      { timestamp: new Date(NaN), probability: 0.5 },
      { timestamp: Infinity, probability: 0.5 },
      point(0, NaN), point(0, Infinity), point(0, -Infinity), point(0, -0.01), point(0, 1.01),
      point(2, 0), point(1, 1),
    ])).toEqual([point(2, 0), point(1, 1)]);
  });
  it("does not mutate inputs or retain mutable point object references", () => {
    const input = Object.freeze([Object.freeze(point(0, 0.6)), Object.freeze(point(1, 0.4))]);
    const normalized = normalizeChartPoints(input);
    normalized[0].probability = 0.9;
    expect(input).toEqual([point(0, 0.6), point(1, 0.4)]);
  });
});

describe("chartDomain", () => {
  it("uses a full probability scale without valid observations", () => {
    expect(chartDomain([])).toEqual([0, 1]);
    expect(chartDomain([point(0, NaN)])).toEqual([0, 1]);
  });
  it("centers a constant series and preserves a minimum ten-point scale", () => {
    const [low, high] = chartDomain([point(1), point(0)]);
    expect(low).toBeCloseTo(0.45);
    expect(high).toBeCloseTo(0.55);
    const smallMove = chartDomain([point(1, 0.5001), point(0, 0.5002)]);
    expect(smallMove[1] - smallMove[0]).toBeCloseTo(0.1);
  });
  it("pads varying values by two probability points", () => {
    const [low, high] = chartDomain([point(1, 0.3), point(0, 0.6)]);
    expect(low).toBeCloseTo(0.28);
    expect(high).toBeCloseTo(0.62);
  });
  it("keeps the minimum span within zero and one", () => {
    expect(chartDomain([point(0, 0)])).toEqual([0, 0.1]);
    const top = chartDomain([point(0, 1)]);
    expect(top[0]).toBeCloseTo(0.9);
    expect(top[1]).toBe(1);
    expect(chartDomain([point(1, 0), point(0, 1)])).toEqual([0, 1]);
  });
});

describe("nearestChartIndex", () => {
  const points = normalizeChartPoints([point(10), point(9.9), point(0)]);
  it("chooses using actual time distance, not evenly spaced indices", () => {
    expect(nearestChartIndex(points, now - 5 * day)).toBe(1);
    expect(nearestChartIndex(points, now - 4 * day)).toBe(2);
  });
  it("clamps to the endpoints and accepts exact observations", () => {
    expect(nearestChartIndex(points, now - 20 * day)).toBe(0);
    expect(nearestChartIndex(points, now + day)).toBe(2);
    expect(nearestChartIndex(points, points[1].timestamp)).toBe(1);
  });
  it("chooses the earlier timestamp at a midpoint", () => {
    expect(nearestChartIndex(points, (points[0].timestamp + points[1].timestamp) / 2)).toBe(0);
  });
  it("handles empty, singleton, and invalid targets explicitly", () => {
    expect(nearestChartIndex([], now)).toBe(-1);
    expect(nearestChartIndex(points.slice(0, 1), now)).toBe(0);
    expect(nearestChartIndex(points, NaN)).toBe(-1);
    expect(nearestChartIndex(points, Infinity)).toBe(-1);
  });
});

describe("selectChartRange", () => {
  it.each([["1H", 1 / 24], ["4H", 4 / 24], ["8H", 8 / 24], ["24H", 1]] as const)("includes the %s cutoff and exactly one real earlier baseline", (range, days) => {
    const input = [point(days + 2, 0.2), point(days + 1, 0.3), point(days, 0.4), point(0, 0.6)];
    expect(selectChartRange(input, range, now)).toEqual(input.slice(1));
  });
  it("anchors stale histories to the supplied clock and retains only their last observation", () => {
    expect(selectChartRange([point(40, 0.3), point(39, 0.4)], "24H", now)).toEqual([point(39, 0.4)]);
  });
  it("does not fabricate a baseline, duplicate a singleton, or include future observations in a recent range", () => {
    expect(selectChartRange([], "24H", now)).toEqual([]);
    expect(selectChartRange([point(0.5)], "24H", now)).toEqual([point(0.5)]);
    expect(selectChartRange([point(-1)], "24H", now)).toEqual([]);
    expect(selectChartRange([point(0), point(-1)], "24H", now)).toEqual([point(0)]);
  });
  it("keeps ALL history without a 500-observation cap", () => {
    const input = Array.from({ length: 750 }, (_, index) => point(750 - index));
    expect(selectChartRange(input, "ALL", now)).toEqual(input);
  });
  it("normalizes without mutating source data and rejects an invalid range clock", () => {
    const input = Object.freeze([Object.freeze(point(0, 0.6)), Object.freeze(point(2, 0.4))]);
    expect(selectChartRange(input, "24H", now)).toEqual([point(2, 0.4), point(0, 0.6)]);
    expect(input).toEqual([point(0, 0.6), point(2, 0.4)]);
    expect(selectChartRange(input, "24H", NaN)).toEqual([]);
  });
});
