export const PROBABILITY_BASIS_POINTS = 10_000n;

export type PricingBookSide = "BID" | "ASK";
export type DisplayPriceSource = "MID" | "LAST" | "SETTLEMENT" | "NONE";

export interface PriceLevel {
  priceMilli: bigint;
  quantity: bigint;
}

export interface TopOfBook {
  bestBid: PriceLevel | null;
  bestAsk: PriceLevel | null;
  spreadMilli: bigint | null;
}

export interface SweepResult {
  requestedQuantity: bigint;
  filledQuantity: bigint;
  unfilledQuantity: bigint;
  grossMilli: bigint;
  averagePriceMilli: bigint | null;
  worstPriceMilli: bigint | null;
  fullyFillable: boolean;
  fills: PriceLevel[];
}

export interface LastTrade {
  priceMilli: bigint;
  executedAtMs: bigint;
}

export interface MarketMarkInput {
  bids: readonly PriceLevel[];
  asks: readonly PriceLevel[];
  payoutMilli: bigint;
  nowMs: bigint;
  lastTrade?: LastTrade | null;
  settlementPriceMilli?: bigint | null;
  maximumMidpointSpreadMilli?: bigint;
  minimumTopLevelQuantity?: bigint;
  staleAfterMs?: bigint;
}

export interface MarketMark {
  displayPriceMilli: bigint | null;
  displayProbabilityBps: bigint | null;
  source: DisplayPriceSource;
  stale: boolean;
  bestBidMilli: bigint | null;
  bestAskMilli: bigint | null;
  spreadMilli: bigint | null;
  quotedSpreadBps: bigint | null;
  lastTradePriceMilli: bigint | null;
  lastTradeAtMs: bigint | null;
}

function assertPositive(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new RangeError(`${name} must be a positive bigint`);
  }
}

function assertNonNegative(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint`);
  }
}

function assertPrice(priceMilli: bigint, payoutMilli: bigint): void {
  if (typeof priceMilli !== "bigint" || priceMilli < 0n || priceMilli > payoutMilli) {
    throw new RangeError("priceMilli must be between zero and payoutMilli");
  }
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  assertNonNegative("numerator", numerator);
  assertPositive("denominator", denominator);
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/** Aggregates duplicate prices and sorts levels best-to-worst for the selected side. */
export function aggregatePriceLevels(
  levels: readonly PriceLevel[],
  side: PricingBookSide,
  payoutMilli?: bigint,
): PriceLevel[] {
  if (side !== "BID" && side !== "ASK") {
    throw new RangeError('side must be "BID" or "ASK"');
  }
  if (payoutMilli !== undefined) assertPositive("payoutMilli", payoutMilli);

  const quantities = new Map<bigint, bigint>();
  for (const level of levels) {
    assertPositive("quantity", level.quantity);
    if (payoutMilli === undefined) {
      assertNonNegative("priceMilli", level.priceMilli);
    } else {
      assertPrice(level.priceMilli, payoutMilli);
    }
    quantities.set(level.priceMilli, (quantities.get(level.priceMilli) ?? 0n) + level.quantity);
  }

  return [...quantities.entries()]
    .map(([priceMilli, quantity]) => ({ priceMilli, quantity }))
    .sort((left, right) => {
      const comparison = compareBigint(left.priceMilli, right.priceMilli);
      return side === "ASK" ? comparison : -comparison;
    });
}

export function bestBidAsk(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
  payoutMilli: bigint,
): TopOfBook {
  assertPositive("payoutMilli", payoutMilli);
  const bestBid = aggregatePriceLevels(bids, "BID", payoutMilli)[0] ?? null;
  const bestAsk = aggregatePriceLevels(asks, "ASK", payoutMilli)[0] ?? null;
  return {
    bestBid,
    bestAsk,
    spreadMilli: bestBid && bestAsk ? bestAsk.priceMilli - bestBid.priceMilli : null,
  };
}

/** Sweeps asks for a buy or bids for a sell. Buy averages round up; sell averages round down. */
export function sweepPriceLevels(
  levels: readonly PriceLevel[],
  side: PricingBookSide,
  requestedQuantity: bigint,
  payoutMilli?: bigint,
): SweepResult {
  assertPositive("requestedQuantity", requestedQuantity);
  const sorted = aggregatePriceLevels(levels, side, payoutMilli);
  let remaining = requestedQuantity;
  let grossMilli = 0n;
  const fills: PriceLevel[] = [];

  for (const level of sorted) {
    if (remaining === 0n) break;
    const quantity = level.quantity < remaining ? level.quantity : remaining;
    fills.push({ priceMilli: level.priceMilli, quantity });
    grossMilli += level.priceMilli * quantity;
    remaining -= quantity;
  }

  const filledQuantity = requestedQuantity - remaining;
  return {
    requestedQuantity,
    filledQuantity,
    unfilledQuantity: remaining,
    grossMilli,
    averagePriceMilli:
      filledQuantity === 0n
        ? null
        : side === "ASK"
          ? ceilDiv(grossMilli, filledQuantity)
          : grossMilli / filledQuantity,
    worstPriceMilli: fills.at(-1)?.priceMilli ?? null,
    fullyFillable: remaining === 0n,
    fills,
  };
}

export function impliedProbabilityBps(priceMilli: bigint, payoutMilli: bigint): bigint {
  assertPositive("payoutMilli", payoutMilli);
  assertPrice(priceMilli, payoutMilli);
  return (priceMilli * PROBABILITY_BASIS_POINTS + payoutMilli / 2n) / payoutMilli;
}

export function quotedSpreadBps(spreadMilli: bigint, payoutMilli: bigint): bigint {
  assertNonNegative("spreadMilli", spreadMilli);
  assertPositive("payoutMilli", payoutMilli);
  return (spreadMilli * PROBABILITY_BASIS_POINTS + payoutMilli / 2n) / payoutMilli;
}

export function effectiveRoundTripSpreadBps(
  bids: readonly PriceLevel[],
  asks: readonly PriceLevel[],
  quantity: bigint,
  payoutMilli: bigint,
): bigint | null {
  const buy = sweepPriceLevels(asks, "ASK", quantity, payoutMilli);
  const sell = sweepPriceLevels(bids, "BID", quantity, payoutMilli);
  if (!buy.fullyFillable || !sell.fullyFillable) return null;
  const difference = (buy.averagePriceMilli ?? 0n) - (sell.averagePriceMilli ?? 0n);
  return quotedSpreadBps(difference > 0n ? difference : 0n, payoutMilli);
}

/**
 * Selects a display mark without inventing liquidity: settlement first, then a
 * qualified two-sided midpoint, then the last trade. One-sided/empty books have
 * no point estimate unless a last trade exists.
 */
export function selectMarketMark(input: MarketMarkInput): MarketMark {
  assertPositive("payoutMilli", input.payoutMilli);
  assertNonNegative("nowMs", input.nowMs);
  const maximumSpread = input.maximumMidpointSpreadMilli ?? input.payoutMilli / 10n;
  const minimumQuantity = input.minimumTopLevelQuantity ?? 1n;
  const staleAfterMs = input.staleAfterMs ?? 3_600_000n;
  assertNonNegative("maximumMidpointSpreadMilli", maximumSpread);
  assertPositive("minimumTopLevelQuantity", minimumQuantity);
  assertNonNegative("staleAfterMs", staleAfterMs);

  const top = bestBidAsk(input.bids, input.asks, input.payoutMilli);
  const bestBidMilli = top.bestBid?.priceMilli ?? null;
  const bestAskMilli = top.bestAsk?.priceMilli ?? null;
  const spread = top.spreadMilli;
  const lastTrade = input.lastTrade ?? null;
  if (lastTrade) {
    assertPrice(lastTrade.priceMilli, input.payoutMilli);
    assertNonNegative("lastTrade.executedAtMs", lastTrade.executedAtMs);
  }

  let displayPriceMilli: bigint | null = null;
  let source: DisplayPriceSource = "NONE";
  let stale = false;

  if (input.settlementPriceMilli !== undefined && input.settlementPriceMilli !== null) {
    assertPrice(input.settlementPriceMilli, input.payoutMilli);
    displayPriceMilli = input.settlementPriceMilli;
    source = "SETTLEMENT";
  } else if (
    top.bestBid &&
    top.bestAsk &&
    top.bestBid.quantity >= minimumQuantity &&
    top.bestAsk.quantity >= minimumQuantity &&
    spread !== null &&
    spread >= 0n &&
    spread <= maximumSpread
  ) {
    displayPriceMilli = (top.bestBid.priceMilli + top.bestAsk.priceMilli + 1n) / 2n;
    source = "MID";
  } else if (lastTrade) {
    displayPriceMilli = lastTrade.priceMilli;
    source = "LAST";
    stale = input.nowMs > lastTrade.executedAtMs + staleAfterMs;
  }

  return {
    displayPriceMilli,
    displayProbabilityBps:
      displayPriceMilli === null ? null : impliedProbabilityBps(displayPriceMilli, input.payoutMilli),
    source,
    stale,
    bestBidMilli,
    bestAskMilli,
    spreadMilli: spread,
    quotedSpreadBps:
      spread !== null && spread >= 0n ? quotedSpreadBps(spread, input.payoutMilli) : null,
    lastTradePriceMilli: lastTrade?.priceMilli ?? null,
    lastTradeAtMs: lastTrade?.executedAtMs ?? null,
  };
}
