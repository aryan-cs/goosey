import { describe, expect, it } from "vitest";
import { formatLocalTime, localTimeIso } from "./local-time";

describe("local time formatting", () => {
  const value = "2026-09-20T02:14:00.000Z";

  it("formats the same instant in the viewer's requested zone", () => {
    expect(formatLocalTime(value, "short", { locale: "en-CA", timeZone: "America/Toronto" })).toContain("10:14 p.m. EDT");
    expect(formatLocalTime(value, "short", { locale: "en-CA", timeZone: "America/Vancouver" })).toContain("7:14 p.m. PDT");
    expect(formatLocalTime(value, "short", { locale: "en-CA", timeZone: "Asia/Kolkata" })).toMatch(/7:44 a\.m\. (?:IST|GMT\+5:30)/);
  });

  it("preserves the canonical instant in the datetime attribute", () => {
    expect(localTimeIso(value)).toBe(value);
    expect(localTimeIso(new Date(value))).toBe(value);
  });

  it("rejects invalid timestamps", () => {
    expect(() => formatLocalTime("not-a-date")).toThrow(RangeError);
    expect(() => localTimeIso("not-a-date")).toThrow(RangeError);
  });
});
