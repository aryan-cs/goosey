import { describe, expect, it } from "vitest";

import { boundedPriceHistory, chronologicalPriceHistory } from "./price-history";

describe("chronologicalPriceHistory", () => {
  it("orders persisted points oldest-first without inventing duplicates", () => {
    const older = new Date("2026-09-18T10:00:00.000Z");
    const newer = new Date("2026-09-18T11:00:00.000Z");
    expect(
      chronologicalPriceHistory(
        [
          { timestamp: newer, probabilityYesBps: 5_600 },
          { timestamp: older, probabilityYesBps: 5_000 },
        ],
        5_600,
        new Date("2026-09-18T12:00:00.000Z"),
      ),
    ).toEqual([
      { timestamp: older, probabilityYesBps: 5_000 },
      { timestamp: newer, probabilityYesBps: 5_600 },
    ]);
  });

  it("appends only the genuine current state when it differs", () => {
    const currentAt = new Date("2026-09-18T12:00:00.000Z");
    expect(
      chronologicalPriceHistory(
        [{ timestamp: new Date("2026-09-18T10:00:00.000Z"), probabilityYesBps: 5_000 }],
        5_750,
        currentAt,
      ).at(-1),
    ).toEqual({ timestamp: currentAt, probabilityYesBps: 5_750 });
  });
});

describe("boundedPriceHistory", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])("retains endpoints and input tie order with a %i-point budget", (limit) => {
    const points = Array.from({ length: 25 }, (_, sequence) => ({
      timestamp: new Date(Date.UTC(2026, 8, 19, 10, Math.floor(sequence / 5))),
      probabilityYesBps: (sequence * 1397) % 10001, sequence,
    }));
    const result = boundedPriceHistory(points, limit);
    expect(result.length).toBeLessThanOrEqual(limit);
    expect(result.at(-1)).toBe(points.at(-1));
    if (limit > 1) expect(result[0]).toBe(points[0]);
    expect(result.every((point, index) => index === 0 || result[index - 1]!.sequence < point.sequence)).toBe(true);
  });

  it("preserves causal input order for equal-time observations after downsampling", () => {
    const points = [5_000, 1_000, 9_000, 4_000, 6_000].map((probabilityYesBps, sequence) => ({
      timestamp: new Date("2026-09-19T10:00:00Z"), probabilityYesBps, sequence,
    }));
    expect(boundedPriceHistory(points, 4).map((point) => point.sequence)).toEqual([0, 1, 2, 4]);
  });

  it("never discards the latest observation when limited to three points", () => {
    const points = [5_000, 1_000, 9_000, 6_000].map((probabilityYesBps, minute) => ({
      timestamp: new Date(Date.UTC(2026, 8, 19, 10, minute)), probabilityYesBps,
    }));
    const bounded = boundedPriceHistory(points, 3);
    expect(bounded).toHaveLength(3);
    expect(bounded[0]).toBe(points[0]);
    expect(bounded.at(-1)).toBe(points.at(-1));
    expect(bounded[1]).toBe(points[1]);
  });

  it("retains the first, last, local low, and local high instead of flattening the series", () => {
    const points = [5_000, 5_100, 2_000, 8_000, 5_200, 4_900, 1_500, 8_500, 5_300, 5_400]
      .map((probabilityYesBps, index) => ({
        timestamp: new Date(Date.UTC(2026, 8, 19, 0, index)),
        probabilityYesBps,
      }));
    const bounded = boundedPriceHistory(points, 6);
    expect(bounded).toHaveLength(6);
    expect(bounded[0]).toEqual(points[0]);
    expect(bounded.at(-1)).toEqual(points.at(-1));
    expect(bounded.map((point) => point.probabilityYesBps)).toEqual(expect.arrayContaining([2_000, 8_000, 1_500, 8_500]));
  });

  it("uses the latest observation when the response budget is one point", () => {
    const points = [
      { timestamp: new Date("2026-09-19T10:00:00.000Z"), probabilityYesBps: 4_000 },
      { timestamp: new Date("2026-09-19T11:00:00.000Z"), probabilityYesBps: 6_000 },
    ];
    expect(boundedPriceHistory(points, 1)).toEqual([points[1]]);
  });
});
