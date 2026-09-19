import { formatDistanceStrict } from "date-fns";

type DateValue = Date | string | number;

function asDate(value: DateValue) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Relative time requires a valid date.");
  return date;
}

export function formatRelativeTime(value: DateValue, now: DateValue = new Date()) {
  const date = asDate(value);
  const reference = asDate(now);
  if (Math.abs(reference.getTime() - date.getTime()) < 10_000) return "Just now";
  return formatDistanceStrict(date, reference, { addSuffix: true, roundingMethod: "floor" });
}
