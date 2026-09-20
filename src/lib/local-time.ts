export type LocalTimePreset = "short" | "medium" | "long" | "date" | "month-year";

const presets: Record<LocalTimePreset, Intl.DateTimeFormatOptions> = {
  short: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  medium: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  long: { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  date: { year: "numeric", month: "short", day: "numeric" },
  "month-year": { year: "numeric", month: "long" },
};

function instant(value: string | Date): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RangeError("Invalid timestamp.");
  return parsed;
}

export function localTimeIso(value: string | Date): string {
  return instant(value).toISOString();
}

export function formatLocalTime(
  value: string | Date,
  preset: LocalTimePreset = "short",
  options: { locale?: string; timeZone?: string } = {},
): string {
  return new Intl.DateTimeFormat(options.locale, {
    ...presets[preset],
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(instant(value));
}

