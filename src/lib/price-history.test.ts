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
