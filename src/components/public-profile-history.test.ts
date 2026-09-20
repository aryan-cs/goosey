import { describe, expect, it } from "vitest";

import {
  heldProfileHistoryPoint,
  normalizeProfileHistory,
  profileHistoryStepPath,
  selectProfileHistoryRange,
  type ProfileHistoryPoint,
} from "./public-profile-history";

const hour = 3_600_000;
const epoch = Date.parse("2026-09-19T12:00:00.000Z");
const point = (hours: number, value: number): ProfileHistoryPoint => ({ timestamp: epoch + hours * hour, value });

describe("normalizeProfileHistory", () => {
  it("sorts actual timestamps and coalesces simultaneous events with last-input-wins semantics", () => {
    expect(normalizeProfileHistory([
      point(2, 30),
      { timestamp: new Date(epoch), value: 10 },
      { timestamp: new Date(epoch + hour).toISOString(), value: 20 },
      point(1, 25),
    ])).toEqual([
      { timestamp: epoch, value: 10 },
      { timestamp: epoch + hour, value: 25 },
      { timestamp: epoch + 2 * hour, value: 30 },
    ]);
  });

  it("rejects invalid observations without mutating or retaining mutable inputs", () => {
    const valid = Object.freeze(point(0, -12.5));
    const input = Object.freeze([
      valid,
      Object.freeze({ timestamp: "not-a-date", value: 3 }),
      Object.freeze({ timestamp: epoch + hour, value: Number.NaN }),
      Object.freeze({ timestamp: epoch + 2 * hour, value: Number.POSITIVE_INFINITY }),
    ]);
    const result = normalizeProfileHistory(input);
    result[0].value = 99;
    expect(input[0]).toEqual(point(0, -12.5));
    expect(normalizeProfileHistory(input)).toEqual([{ timestamp: epoch, value: -12.5 }]);
  });
});

describe("heldProfileHistoryPoint", () => {
  const points = [point(0, 10), point(1, 20), point(4, 40)];

  it("holds the last real value at arbitrary cursor timestamps", () => {
    expect(heldProfileHistoryPoint(points, epoch + 3 * hour)).toEqual({ timestamp: epoch + hour, value: 20 });
    expect(heldProfileHistoryPoint(points, epoch + 4 * hour)).toEqual({ timestamp: epoch + 4 * hour, value: 40 });
    expect(heldProfileHistoryPoint(points, epoch + 40 * hour)).toEqual({ timestamp: epoch + 4 * hour, value: 40 });
  });

  it("returns no invented value before coverage or for invalid cursors", () => {
    expect(heldProfileHistoryPoint(points, epoch - 1)).toBeNull();
    expect(heldProfileHistoryPoint(points, Number.NaN)).toBeNull();
    expect(heldProfileHistoryPoint([], epoch)).toBeNull();
  });
});

describe("selectProfileHistoryRange", () => {
  it("retains exactly one real pre-window observation as the held baseline", () => {
    expect(selectProfileHistoryRange(
      [point(-3, 5), point(-1, 10), point(1, 20), point(2, 30), point(5, 40)],
      epoch,
      epoch + 3 * hour,
    )).toEqual([
      { timestamp: epoch - hour, value: 10 },
      { timestamp: epoch + hour, value: 20 },
      { timestamp: epoch + 2 * hour, value: 30 },
    ]);
  });

  it("does not duplicate an observation on the boundary or include future events", () => {
    expect(selectProfileHistoryRange([point(0, 10), point(1, 20), point(4, 40)], epoch, epoch + 2 * hour)).toEqual([
      { timestamp: epoch, value: 10 },
      { timestamp: epoch + hour, value: 20 },
    ]);
  });

  it("rejects invalid and reversed domains", () => {
    expect(selectProfileHistoryRange([point(0, 10)], Number.NaN, epoch)).toEqual([]);
    expect(selectProfileHistoryRange([point(0, 10)], epoch + hour, epoch)).toEqual([]);
  });
});

describe("profileHistoryStepPath", () => {
  const options = {
    startAt: epoch,
    endAt: epoch + 4 * hour,
    width: 400,
    height: 100,
    minValue: 0,
    maxValue: 100,
  };

  it("scales x by elapsed time and holds each value until the next actual event", () => {
    expect(profileHistoryStepPath([point(0, 10), point(1, 50), point(3, 20)], options))
      .toBe("M0,90 H100 V50 H300 V80 H400");
  });

  it("carries a real pre-window value to the boundary without creating a pre-coverage line", () => {
    expect(profileHistoryStepPath([point(-2, 30), point(2, 60)], options))
      .toBe("M0,70 H200 V40 H400");
    expect(profileHistoryStepPath([point(2, 60)], options))
      .toBe("M200,40 H400");
  });

  it("places simultaneous events once and handles a constant value domain", () => {
    expect(profileHistoryStepPath([point(0, 10), point(2, 20), point(2, 25)], { ...options, minValue: 25, maxValue: 25 }))
      .toBe("M0,50 H200 V50 H400");
  });

  it("returns no path for empty data or invalid geometry", () => {
    expect(profileHistoryStepPath([], options)).toBe("");
    expect(profileHistoryStepPath([point(0, 10)], { ...options, endAt: epoch })).toBe("");
    expect(profileHistoryStepPath([point(0, 10)], { ...options, width: 0 })).toBe("");
    expect(profileHistoryStepPath([point(0, 10)], { ...options, minValue: 20, maxValue: 10 })).toBe("");
  });
});
