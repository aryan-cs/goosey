/**
 * Authoritative binary LMSR arithmetic for Goosey.
 *
 * Quantities and liquidity are integer contracts. All public monetary values are
 * integer milli-feathers (`bigint`). Floating point is used only inside the
 * bounded transcendental calculation; conservative rounding includes an error
 * reserve so floating-point uncertainty always favours the collateral pool.
 */

export const DEFAULT_PAYOUT_MILLI = 100_000n;
export const VOID_PAYOUT_BPS = 5_000;
export const BASIS_POINTS = 10_000;

export const MARKET_MAKER_LIMITS = Object.freeze({
  maxQuantity: 10_000_000,
  maxLiquidity: 1_000_000,
  maxPayoutMilli: 1_000_000n,
  maxFeeBps: 10_000,
});

export type Outcome = "YES" | "NO";
export type TradeAction = "BUY" | "SELL";

export interface MarketMakerState {
  yesQuantity: number;
  noQuantity: number;
  liquidity: number;
  payoutMilli?: bigint;
}

export interface TradeQuote {
  outcome: Outcome;
  action: TradeAction;
  quantity: number;
  grossMilli: bigint;
  feeMilli: bigint;
  totalDebitMilli: bigint;
  netCreditMilli: bigint;
  averagePriceMilli: bigint;
  probabilityYesBeforeBps: number;
  probabilityYesAfterBps: number;
  stateAfter: Required<MarketMakerState>;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
// At the configured bounds, this is comfortably larger than accumulated
// libm/IEEE-754 error while remaining below one milli-feather.
const ROUNDING_RESERVE_MILLI = 0.25;

function assertSafeInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
}

function assertBigInt(name: string, value: unknown, min: bigint, max: bigint): asserts value is bigint {
  if (typeof value !== "bigint" || value < min || value > max) {
    throw new RangeError(`${name} must be a bigint between ${min} and ${max}`);
  }
}

function normalizeState(state: MarketMakerState): Required<MarketMakerState> {
  if (state === null || typeof state !== "object") {
    throw new TypeError("state must be an object");
  }

  assertSafeInteger("yesQuantity", state.yesQuantity, 0, MARKET_MAKER_LIMITS.maxQuantity);
  assertSafeInteger("noQuantity", state.noQuantity, 0, MARKET_MAKER_LIMITS.maxQuantity);
  assertSafeInteger("liquidity", state.liquidity, 1, MARKET_MAKER_LIMITS.maxLiquidity);
  const payoutMilli = state.payoutMilli ?? DEFAULT_PAYOUT_MILLI;
  assertBigInt("payoutMilli", payoutMilli, 1n, MARKET_MAKER_LIMITS.maxPayoutMilli);

  return { ...state, payoutMilli };
}

function assertOutcome(outcome: string): asserts outcome is Outcome {
  if (outcome !== "YES" && outcome !== "NO") {
    throw new RangeError('outcome must be "YES" or "NO"');
  }
}

function assertAction(action: string): asserts action is TradeAction {
  if (action !== "BUY" && action !== "SELL") {
    throw new RangeError('action must be "BUY" or "SELL"');
  }
}

/** Stable logistic function with no overflowing exponential. */
function logistic(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function toSafeNumber(value: bigint, name: string): number {
  if (value > MAX_SAFE_BIGINT || value < -MAX_SAFE_BIGINT) {
    throw new RangeError(`${name} exceeds the supported exact integer range`);
  }
  return Number(value);
}

function conservativeCeil(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 1) {
    throw new RangeError("monetary result is outside the supported range");
  }
  return BigInt(Math.ceil(value + ROUNDING_RESERVE_MILLI));
}

function ceilRatio(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Absolute LMSR cost, rounded upward to integer milli-feathers.
 * C(q) = b * payout * log(exp(qYes / b) + exp(qNo / b)).
 */
export function lmsrCostMilli(input: MarketMakerState): bigint {
  const state = normalizeState(input);
  const maxQuantity = Math.max(state.yesQuantity, state.noQuantity);
  const spread = Math.abs(state.yesQuantity - state.noQuantity) / state.liquidity;
  const logSumExp = maxQuantity / state.liquidity + Math.log1p(Math.exp(-spread));
  const cost = state.liquidity * toSafeNumber(state.payoutMilli, "payoutMilli") * logSumExp;
  return conservativeCeil(cost);
}

/** Current YES marginal probability, rounded to the nearest basis point. */
export function probabilityYesBps(input: MarketMakerState): number {
  const state = normalizeState(input);
  const logOdds = (state.yesQuantity - state.noQuantity) / state.liquidity;
  return Math.max(0, Math.min(BASIS_POINTS, Math.round(logistic(logOdds) * BASIS_POINTS)));
}

export function probabilityBps(input: MarketMakerState, outcome: Outcome): number {
  assertOutcome(outcome);
  const yes = probabilityYesBps(input);
  return outcome === "YES" ? yes : BASIS_POINTS - yes;
}

/** Minimum initial collateral that covers the LMSR maker's worst-case loss. */
export function initialSubsidyMilli(
  liquidity: number,
  payoutMilli: bigint = DEFAULT_PAYOUT_MILLI,
): bigint {
  assertSafeInteger("liquidity", liquidity, 1, MARKET_MAKER_LIMITS.maxLiquidity);
  assertBigInt("payoutMilli", payoutMilli, 1n, MARKET_MAKER_LIMITS.maxPayoutMilli);
  return conservativeCeil(liquidity * toSafeNumber(payoutMilli, "payoutMilli") * Math.LN2);
}

/** Collateral required to pay the more expensive binary resolution. */
export function requiredCollateralMilli(input: MarketMakerState): bigint {
  const state = normalizeState(input);
  return BigInt(Math.max(state.yesQuantity, state.noQuantity)) * state.payoutMilli;
}

/** Exact winning-outcome settlement payout. */
export function settlementPayoutMilli(quantity: number, payoutMilli: bigint = DEFAULT_PAYOUT_MILLI): bigint {
  assertSafeInteger("quantity", quantity, 0, MARKET_MAKER_LIMITS.maxQuantity);
  assertBigInt("payoutMilli", payoutMilli, 1n, MARKET_MAKER_LIMITS.maxPayoutMilli);
  return BigInt(quantity) * payoutMilli;
}

/** Exact 50/50 void payout, rounded down if a custom payout is indivisible. */
export function voidPayoutMilli(quantity: number, payoutMilli: bigint = DEFAULT_PAYOUT_MILLI): bigint {
  return (settlementPayoutMilli(quantity, payoutMilli) * BigInt(VOID_PAYOUT_BPS)) / BigInt(BASIS_POINTS);
}

function calculateTradeQuote(
  input: MarketMakerState,
  outcome: Outcome,
  action: TradeAction,
  quantity: number,
  feeBps = 0,
): TradeQuote {
  const state = normalizeState(input);
  assertOutcome(outcome);
  assertAction(action);
  assertSafeInteger("quantity", quantity, 1, MARKET_MAKER_LIMITS.maxQuantity);
  assertSafeInteger("feeBps", feeBps, 0, MARKET_MAKER_LIMITS.maxFeeBps);

  const selected = outcome === "YES" ? state.yesQuantity : state.noQuantity;
  if (action === "SELL" && quantity > selected) {
    throw new RangeError("cannot sell more contracts than are outstanding");
  }
  if (action === "BUY" && selected + quantity > MARKET_MAKER_LIMITS.maxQuantity) {
    throw new RangeError("trade would exceed the maximum outcome quantity");
  }

  const direction = action === "BUY" ? quantity : -quantity;
  const stateAfter: Required<MarketMakerState> = {
    ...state,
    yesQuantity: state.yesQuantity + (outcome === "YES" ? direction : 0),
    noQuantity: state.noQuantity + (outcome === "NO" ? direction : 0),
  };
  // Price both directions from one discretized cost potential. Reversing a
  // fee-free state transition then returns the exact same milli-feathers.
  const costBefore = lmsrCostMilli(state);
  const costAfter = lmsrCostMilli(stateAfter);
  const grossMilli = action === "BUY" ? costAfter - costBefore : costBefore - costAfter;
  if (grossMilli < 0n) throw new Error("LMSR cost moved opposite the trade direction");
  const feeMilli = ceilRatio(grossMilli * BigInt(feeBps), BigInt(BASIS_POINTS));
  const totalDebitMilli = action === "BUY" ? grossMilli + feeMilli : 0n;
  const netCreditMilli = action === "SELL" ? grossMilli - feeMilli : 0n;

  return {
    outcome,
    action,
    quantity,
    grossMilli,
    feeMilli,
    totalDebitMilli,
    netCreditMilli,
    averagePriceMilli:
      action === "BUY"
        ? ceilRatio(grossMilli, BigInt(quantity))
        : grossMilli / BigInt(quantity),
    probabilityYesBeforeBps: probabilityYesBps(state),
    probabilityYesAfterBps: probabilityYesBps(stateAfter),
    stateAfter,
  };
}

export function quoteTrade(
  input: MarketMakerState,
  outcome: Outcome,
  action: TradeAction,
  quantity: number,
  feeBps = 0,
): TradeQuote {
  const quote = calculateTradeQuote(input, outcome, action, quantity, feeBps);
  if (quote.grossMilli <= 0n) {
    throw new RangeError("trade value rounds to zero");
  }
  if (action === "SELL" && quote.netCreditMilli <= 0n) {
    throw new RangeError("sell proceeds do not exceed the fee");
  }
  return quote;
}

/** Valid holdings can be worth zero even when no sell can be executed. */
export function sellLiquidationValueMilli(
  input: MarketMakerState,
  outcome: Outcome,
  quantity: number,
  feeBps = 0,
): bigint {
  return calculateTradeQuote(input, outcome, "SELL", quantity, feeBps).netCreditMilli;
}

export function quoteBuy(
  state: MarketMakerState,
  outcome: Outcome,
  quantity: number,
  feeBps = 0,
): TradeQuote {
  return quoteTrade(state, outcome, "BUY", quantity, feeBps);
}

export function quoteSell(
  state: MarketMakerState,
  outcome: Outcome,
  quantity: number,
  feeBps = 0,
): TradeQuote {
  return quoteTrade(state, outcome, "SELL", quantity, feeBps);
}
