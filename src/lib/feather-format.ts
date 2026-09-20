export const MILLI_PER_FEATHER = 1_000n;

export function formatFeathers(milli: bigint, maximumFractionDigits = 0): string {
  if (!Number.isInteger(maximumFractionDigits) || maximumFractionDigits < 0 || maximumFractionDigits > 3) {
    throw new RangeError("maximumFractionDigits must be an integer from 0 to 3");
  }
  const negative = milli < 0n;
  const absolute = negative ? -milli : milli;
  const roundingUnit = 10n ** BigInt(3 - maximumFractionDigits);
  const rounded = ((absolute + roundingUnit / 2n) / roundingUnit) * roundingUnit;
  const sign = negative && rounded !== 0n ? "-" : "";
  const whole = rounded / MILLI_PER_FEATHER;
  const groupedWhole = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 0 }).format(whole);
  if (maximumFractionDigits === 0) return `${sign}${groupedWhole}`;
  const fraction = (rounded % MILLI_PER_FEATHER)
    .toString()
    .padStart(3, "0")
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, "");
  return `${sign}${groupedWhole}${fraction ? `.${fraction}` : ""}`;
}
