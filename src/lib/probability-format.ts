const BASIS_POINTS = 10_000;
const BASIS_POINTS_PER_PERCENT = 100;

export function probabilityFractionToBps(probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("probability must be between zero and one");
  }
  return Math.max(
    0,
    Math.min(BASIS_POINTS, Math.round(probability * BASIS_POINTS)),
  );
}

/** Whole-percent display using integer half-up rounding. */
export function probabilityBpsToWholePercent(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > BASIS_POINTS) {
    throw new RangeError("probability bps must be an integer from 0 to 10000");
  }
  return Math.floor(
    (bps + BASIS_POINTS_PER_PERCENT / 2) / BASIS_POINTS_PER_PERCENT,
  );
}

export function complementaryWholePercents(yesBps: number): {
  yes: number;
  no: number;
} {
  const yes = probabilityBpsToWholePercent(yesBps);
  return { yes, no: 100 - yes };
}

export function probabilityFractionLabel(probability: number): string {
  return `${probabilityBpsToWholePercent(probabilityFractionToBps(probability))}%`;
}

/** Signed probability-point movement, rounded to the nearest whole point. */
export function probabilityMovementPoints(
  fromBps: number,
  toBps: number,
): number {
  const delta = toBps - fromBps;
  const magnitude = Math.floor(
    (Math.abs(delta) + BASIS_POINTS_PER_PERCENT / 2) / BASIS_POINTS_PER_PERCENT,
  );
  return delta < 0 ? -magnitude : magnitude;
}
