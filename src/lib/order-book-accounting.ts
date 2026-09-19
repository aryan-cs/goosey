/**
 * Pure, exact accounting primitives for Goosey's binary CLOB.
 *
 * All authoritative values are bigint. These helpers deliberately know
 * nothing about persistence, users, or Prisma; transaction code can turn the
 * returned plans into durable reservations and balanced journal postings.
 */

export const FEE_BASIS_POINTS = 10_000n;

export type OrderOutcome = "YES" | "NO";
export type OrderAction = "BUY" | "SELL";
export type FillParty = "MAKER" | "TAKER";
export type FillEconomicKind = "MINT" | "BURN" | "TRANSFER_YES" | "TRANSFER_NO";

export interface OrderIntent {
  outcome: OrderOutcome;
  action: OrderAction;
}

export interface ReservationInput extends OrderIntent {
  limitPriceMilli: bigint;
  quantity: bigint;
  payoutMilli: bigint;
  makerFeeBps: bigint;
  takerFeeBps: bigint;
  /** A post-only order can only execute as maker. */
  postOnly?: boolean;
}

export interface OrderReservation {
  principalMilli: bigint;
  maximumFeeMilli: bigint;
  cashReserveMilli: bigint;
  shareReserve: {
    outcome: OrderOutcome;
    quantity: bigint;
  } | null;
  worstCaseFeeBps: bigint;
}

export interface CumulativeFeeDeltaInput {
  previousExecutedNotionalMilli: bigint;
  fillNotionalMilli: bigint;
  feeBps: bigint;
}

export type JournalOwner = FillParty | "MARKET" | "PROTOCOL";
export type JournalBucket = "RESERVED_CASH" | "AVAILABLE_CASH" | "COLLATERAL" | "REVENUE";

export interface JournalPostingPlan {
  owner: JournalOwner;
  bucket: JournalBucket;
  amountMilli: bigint;
}

export interface FillJournalInput {
  maker: OrderIntent;
  taker: OrderIntent;
  canonicalYesPriceMilli: bigint;
  quantity: bigint;
  payoutMilli: bigint;
  makerFeeMilli: bigint;
  takerFeeMilli: bigint;
}

export interface FillJournalPlan {
  economicKind: FillEconomicKind;
  yesPrincipalMilli: bigint;
  noPrincipalMilli: bigint;
  postings: JournalPostingPlan[];
}

function assertNonNegative(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value < 0n) {
    throw new RangeError(`${name} must be a non-negative bigint`);
  }
}

function assertPositive(name: string, value: bigint): void {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new RangeError(`${name} must be a positive bigint`);
  }
}

function assertFeeBps(name: string, value: bigint): void {
  assertNonNegative(name, value);
  if (value > FEE_BASIS_POINTS) {
    throw new RangeError(`${name} cannot exceed ${FEE_BASIS_POINTS}`);
  }
}

function assertIntent(name: string, intent: OrderIntent): void {
  if (intent.outcome !== "YES" && intent.outcome !== "NO") {
    throw new RangeError(`${name}.outcome must be YES or NO`);
  }
  if (intent.action !== "BUY" && intent.action !== "SELL") {
    throw new RangeError(`${name}.action must be BUY or SELL`);
  }
}

function assertPrice(priceMilli: bigint, payoutMilli: bigint): void {
  assertPositive("payoutMilli", payoutMilli);
  if (typeof priceMilli !== "bigint" || priceMilli <= 0n || priceMilli >= payoutMilli) {
    throw new RangeError("price must be greater than zero and less than payoutMilli");
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  assertNonNegative("numerator", numerator);
  assertPositive("denominator", denominator);
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/** Fee rounded upward once over the supplied cumulative notional. */
export function cumulativeFeeMilli(executedNotionalMilli: bigint, feeBps: bigint): bigint {
  assertNonNegative("executedNotionalMilli", executedNotionalMilli);
  assertFeeBps("feeBps", feeBps);
  return ceilDiv(executedNotionalMilli * feeBps, FEE_BASIS_POINTS);
}

/**
 * Incremental fee for a fill, calculated from cumulative notional.
 * Summing these deltas telescopes to the fee on total notional, so splitting a
 * fill cannot create additional rounding fees.
 */
export function cumulativeFeeDeltaMilli(input: CumulativeFeeDeltaInput): bigint {
  assertNonNegative("previousExecutedNotionalMilli", input.previousExecutedNotionalMilli);
  assertNonNegative("fillNotionalMilli", input.fillNotionalMilli);
  assertFeeBps("feeBps", input.feeBps);

  const before = cumulativeFeeMilli(input.previousExecutedNotionalMilli, input.feeBps);
  const after = cumulativeFeeMilli(
    input.previousExecutedNotionalMilli + input.fillNotionalMilli,
    input.feeBps,
  );
  return after - before;
}

/**
 * Fully reserves a buy's limit-price principal and maximum maker/taker fee.
 * A sell reserves owned contracts; its execution fee is deducted from proceeds.
 */
export function calculateOrderReservation(input: ReservationInput): OrderReservation {
  assertIntent("order", input);
  assertPrice(input.limitPriceMilli, input.payoutMilli);
  assertPositive("quantity", input.quantity);
  assertFeeBps("makerFeeBps", input.makerFeeBps);
  assertFeeBps("takerFeeBps", input.takerFeeBps);

  const worstCaseFeeBps = input.postOnly
    ? input.makerFeeBps
    : input.makerFeeBps > input.takerFeeBps
      ? input.makerFeeBps
      : input.takerFeeBps;
  const principalMilli = input.limitPriceMilli * input.quantity;
  // A buy cannot execute above its user-side limit. A sell can receive price
  // improvement up to the highest legal price; its fee comes from proceeds,
  // so this amount is reported for exposure checks but is not cash-reserved.
  const maximumFeeNotionalMilli = input.action === "BUY"
    ? principalMilli
    : (input.payoutMilli - 1n) * input.quantity;
  const maximumFeeMilli = cumulativeFeeMilli(maximumFeeNotionalMilli, worstCaseFeeBps);

  if (input.action === "BUY") {
    return {
      principalMilli,
      maximumFeeMilli,
      cashReserveMilli: principalMilli + maximumFeeMilli,
      shareReserve: null,
      worstCaseFeeBps,
    };
  }

  return {
    principalMilli,
    maximumFeeMilli,
    cashReserveMilli: 0n,
    shareReserve: { outcome: input.outcome, quantity: input.quantity },
    worstCaseFeeBps,
  };
}

function canonicalSide(intent: OrderIntent): "BID" | "ASK" {
  if (intent.outcome === "YES") return intent.action === "BUY" ? "BID" : "ASK";
  return intent.action === "BUY" ? "ASK" : "BID";
}

/** Classifies a canonical bid/ask match from the two original user intents. */
export function classifyFillEconomics(
  first: OrderIntent,
  second: OrderIntent,
): FillEconomicKind {
  assertIntent("first", first);
  assertIntent("second", second);
  if (canonicalSide(first) === canonicalSide(second)) {
    throw new RangeError("fill intents must be on opposite canonical book sides");
  }

  const intents = [first, second] as const;
  const has = (outcome: OrderOutcome, action: OrderAction) =>
    intents.some((intent) => intent.outcome === outcome && intent.action === action);

  if (has("YES", "BUY") && has("NO", "BUY")) return "MINT";
  if (has("YES", "SELL") && has("NO", "SELL")) return "BURN";
  if (has("YES", "BUY") && has("YES", "SELL")) return "TRANSFER_YES";
  if (has("NO", "BUY") && has("NO", "SELL")) return "TRANSFER_NO";

  throw new RangeError("unsupported fill intent combination");
}

function participantPosting(
  party: FillParty,
  intent: OrderIntent,
  principalMilli: bigint,
  feeMilli: bigint,
): JournalPostingPlan {
  if (intent.action === "BUY") {
    return {
      owner: party,
      bucket: "RESERVED_CASH",
      amountMilli: -(principalMilli + feeMilli),
    };
  }
  if (feeMilli > principalMilli) {
    throw new RangeError(`${party.toLowerCase()} fee cannot exceed sale proceeds`);
  }
  return {
    owner: party,
    bucket: "AVAILABLE_CASH",
    amountMilli: principalMilli - feeMilli,
  };
}

function principalFor(intent: OrderIntent, yesPrincipalMilli: bigint, noPrincipalMilli: bigint): bigint {
  return intent.outcome === "YES" ? yesPrincipalMilli : noPrincipalMilli;
}

function nonZero(postings: JournalPostingPlan[]): JournalPostingPlan[] {
  return postings.filter((posting) => posting.amountMilli !== 0n);
}

/**
 * Produces the complete monetary journal for one fill. Contract movements are
 * represented by economicKind and are intentionally not monetary postings.
 */
export function planFillJournal(input: FillJournalInput): FillJournalPlan {
  assertIntent("maker", input.maker);
  assertIntent("taker", input.taker);
  assertPrice(input.canonicalYesPriceMilli, input.payoutMilli);
  assertPositive("quantity", input.quantity);
  assertNonNegative("makerFeeMilli", input.makerFeeMilli);
  assertNonNegative("takerFeeMilli", input.takerFeeMilli);

  const economicKind = classifyFillEconomics(input.maker, input.taker);
  const yesPrincipalMilli = input.canonicalYesPriceMilli * input.quantity;
  const noPrincipalMilli = (input.payoutMilli - input.canonicalYesPriceMilli) * input.quantity;
  const makerPrincipal = principalFor(input.maker, yesPrincipalMilli, noPrincipalMilli);
  const takerPrincipal = principalFor(input.taker, yesPrincipalMilli, noPrincipalMilli);
  const feesMilli = input.makerFeeMilli + input.takerFeeMilli;

  const participantPostings = [
    participantPosting("MAKER", input.maker, makerPrincipal, input.makerFeeMilli),
    participantPosting("TAKER", input.taker, takerPrincipal, input.takerFeeMilli),
  ];
  const postings: JournalPostingPlan[] = [...participantPostings];

  if (economicKind === "MINT") {
    postings.push({ owner: "MARKET", bucket: "COLLATERAL", amountMilli: input.payoutMilli * input.quantity });
  } else if (economicKind === "BURN") {
    postings.unshift({ owner: "MARKET", bucket: "COLLATERAL", amountMilli: -(input.payoutMilli * input.quantity) });
  }
  if (feesMilli > 0n) {
    postings.push({ owner: "PROTOCOL", bucket: "REVENUE", amountMilli: feesMilli });
  }

  const result = nonZero(postings);
  if (sumJournalPostings(result) !== 0n) {
    throw new Error("fill journal plan is not balanced");
  }

  return { economicKind, yesPrincipalMilli, noPrincipalMilli, postings: result };
}

export function sumJournalPostings(postings: readonly JournalPostingPlan[]): bigint {
  return postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
}
