import { describe, expect, it } from "vitest";
import { HACK_THE_NORTH_CHART_START as start, withOpeningBaseline } from "./chart-opening";
describe("opening-price display baseline", () => {
  it("holds the actual opening price until the first observation without changing it", () => {
    const actual = { timestamp: start + 60_000, probability: .63 };
    expect(withOpeningBaseline([actual], { probability: .6, until: actual.timestamp }, start + 90_000)).toEqual([
      { timestamp: start, probability: .6, opening: true },
      { timestamp: actual.timestamp - 1, probability: .6, opening: true },
      actual,
    ]);
  });
  it("shows an inactive market flat through now", () => {
    const series = withOpeningBaseline([], { probability: .35, until: start + 100_000 }, start + 50_000);
    expect(series.map(p => p.probability)).toEqual([.35, .35]);
    expect(series.at(-1)?.timestamp).toBe(start + 50_000);
  });
  it("does not invent an execution price or overwrite pre-event history", () => {
    expect(withOpeningBaseline([], undefined, start + 1000)).toEqual([]);
    const history = [{ timestamp: start - 1000, probability: .2 }];
    expect(withOpeningBaseline(history, { probability: .5, until: start + 1000 }, start + 2000)).toEqual(history);
  });
  it("does not add future or invalid opening values", () => {
    expect(withOpeningBaseline([], { probability: .5, until: start + 1000 }, start - 1)).toEqual([]);
    expect(withOpeningBaseline([], { probability: NaN, until: start + 1000 }, start + 2000)).toEqual([]);
  });
});
