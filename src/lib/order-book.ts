import type { Outcome, TradeAction } from "./market-maker";

export const ORDER_BOOK_LIMITS = Object.freeze({
  maxQuantity: 10_000_000,
  maxPayoutMilli: 1_000_000n,
  maxActiveOrdersPerUserMarket: 100,
  maxActiveOrdersPerMarket: 10_000,
});

export type BookSide = "BUY" | "SELL";
export type TimeInForce = "GTC" | "IOC" | "FOK";
export type SelfTradePrevention = "CANCEL_AGGRESSOR" | "CANCEL_RESTING" | "CANCEL_BOTH";

export interface RestingOrder {
  id: string;
  ownerId: string;
  stpOwnerId: string;
  side: BookSide;
  limitPriceMilli: bigint;
  remainingQuantity: number;
  prioritySequence: bigint;
}

export interface IncomingOrder extends RestingOrder {
  timeInForce: TimeInForce;
  postOnly: boolean;
  selfTradePrevention: SelfTradePrevention;
}

export interface OrderFill {
  makerOrderId: string;
  takerOrderId: string;
  makerOwnerId: string;
  takerOwnerId: string;
  priceMilli: bigint;
  quantity: number;
}

export type OrderDisposition =
  | "FILLED"
  | "RESTING"
  | "PARTIALLY_FILLED_AND_RESTING"
  | "CANCELED"
  | "PARTIALLY_FILLED_AND_CANCELED"
  | "SELF_TRADE_PREVENTED"
  | "POST_ONLY_WOULD_TRADE"
  | "FOK_NOT_FILLABLE";

export interface MatchResult {
  disposition: OrderDisposition;
  fills: OrderFill[];
  restingOrders: RestingOrder[];
  filledQuantity: number;
  canceledQuantity: number;
  remainingQuantity: number;
  preventedOrderIds: string[];
}

export interface NormalizedOrder {
  side: BookSide;
  limitPriceMilli: bigint;
}

function assertInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a safe integer between ${min} and ${max}`);
  }
}

function assertPrice(price: bigint, payoutMilli: bigint): void {
  if (typeof price !== "bigint" || price <= 0n || price >= payoutMilli) {
    throw new RangeError("limitPriceMilli must be greater than zero and less than payoutMilli");
  }
}

function assertPayout(payoutMilli: bigint): void {
  if (
    typeof payoutMilli !== "bigint" ||
    payoutMilli <= 1n ||
    payoutMilli > ORDER_BOOK_LIMITS.maxPayoutMilli
  ) {
    throw new RangeError(`payoutMilli must be a bigint between 2 and ${ORDER_BOOK_LIMITS.maxPayoutMilli}`);
  }
}

function assertBookSide(side: string): asserts side is BookSide {
  if (side !== "BUY" && side !== "SELL") {
    throw new RangeError('side must be "BUY" or "SELL"');
  }
}

function assertIncomingOrder(order: IncomingOrder): void {
  if (order.timeInForce !== "GTC" && order.timeInForce !== "IOC" && order.timeInForce !== "FOK") {
    throw new RangeError("unsupported timeInForce");
  }
  if (typeof order.postOnly !== "boolean") {
    throw new RangeError("postOnly must be a boolean");
  }
  if (
    order.selfTradePrevention !== "CANCEL_AGGRESSOR" &&
    order.selfTradePrevention !== "CANCEL_RESTING" &&
    order.selfTradePrevention !== "CANCEL_BOTH"
  ) {
    throw new RangeError("unsupported selfTradePrevention");
  }
}

function assertOrder(order: RestingOrder, payoutMilli: bigint): void {
  if (!order.id || !order.ownerId || !order.stpOwnerId) {
    throw new RangeError("order identity fields must be non-empty");
  }
  assertBookSide(order.side);
  assertPrice(order.limitPriceMilli, payoutMilli);
  assertInteger("remainingQuantity", order.remainingQuantity, 1, ORDER_BOOK_LIMITS.maxQuantity);
  if (typeof order.prioritySequence !== "bigint" || order.prioritySequence < 0n) {
    throw new RangeError("prioritySequence must be a non-negative bigint");
  }
}

/**
 * Converts the public YES/NO action vocabulary to one canonical YES book.
 * Buying NO at n is selling YES at payout-n, and vice versa.
 */
export function normalizeToYesBook(
  outcome: Outcome,
  action: TradeAction,
  limitPriceMilli: bigint,
  payoutMilli: bigint,
): NormalizedOrder {
  assertPayout(payoutMilli);
  assertPrice(limitPriceMilli, payoutMilli);
  if (outcome !== "YES" && outcome !== "NO") {
    throw new RangeError('outcome must be "YES" or "NO"');
  }
  if (action !== "BUY" && action !== "SELL") {
    throw new RangeError('action must be "BUY" or "SELL"');
  }
  if (outcome === "YES") {
    return { side: action, limitPriceMilli };
  }
  return {
    side: action === "BUY" ? "SELL" : "BUY",
    limitPriceMilli: payoutMilli - limitPriceMilli,
  };
}

export function denormalizeYesPrice(
  outcome: Outcome,
  canonicalYesPriceMilli: bigint,
  payoutMilli: bigint,
): bigint {
  assertPayout(payoutMilli);
  assertPrice(canonicalYesPriceMilli, payoutMilli);
  if (outcome !== "YES" && outcome !== "NO") {
    throw new RangeError('outcome must be "YES" or "NO"');
  }
  return outcome === "YES" ? canonicalYesPriceMilli : payoutMilli - canonicalYesPriceMilli;
}

function compareOrders(a: RestingOrder, b: RestingOrder): number {
  if (a.side !== b.side) {
    return a.side === "BUY" ? -1 : 1;
  }
  if (a.limitPriceMilli !== b.limitPriceMilli) {
    if (a.side === "BUY") {
      return a.limitPriceMilli > b.limitPriceMilli ? -1 : 1;
    }
    return a.limitPriceMilli < b.limitPriceMilli ? -1 : 1;
  }
  if (a.prioritySequence !== b.prioritySequence) {
    return a.prioritySequence < b.prioritySequence ? -1 : 1;
  }
  // Do not use localeCompare here. Matching priority must not depend on the
  // host's locale or ICU version when sequence numbers tie.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortBook(orders: readonly RestingOrder[]): RestingOrder[] {
  return orders.map((order) => ({ ...order })).sort(compareOrders);
}

function crosses(incoming: RestingOrder, maker: RestingOrder): boolean {
  if (incoming.side === maker.side) return false;
  return incoming.side === "BUY"
    ? incoming.limitPriceMilli >= maker.limitPriceMilli
    : incoming.limitPriceMilli <= maker.limitPriceMilli;
}

function oppositeMakers(book: readonly RestingOrder[], incoming: RestingOrder): RestingOrder[] {
  return book
    .filter((order) => order.side !== incoming.side)
    .map((order) => ({ ...order }))
    .sort(compareOrders);
}

function executableQuantity(
  book: readonly RestingOrder[],
  incoming: IncomingOrder,
): number {
  let quantity = 0;
  for (const maker of oppositeMakers(book, incoming)) {
    if (!crosses(incoming, maker)) break;
    if (maker.stpOwnerId === incoming.stpOwnerId) {
      if (incoming.selfTradePrevention === "CANCEL_AGGRESSOR" || incoming.selfTradePrevention === "CANCEL_BOTH") {
        break;
      }
      continue;
    }
    quantity += maker.remainingQuantity;
    if (quantity >= incoming.remainingQuantity) return incoming.remainingQuantity;
  }
  return quantity;
}

/**
 * Deterministic price-time matcher. It is intentionally pure: persistence,
 * reservations, journals, and IDs are committed by the transaction layer from
 * the returned effects.
 */
export function matchOrder(
  currentBook: readonly RestingOrder[],
  incomingOrder: IncomingOrder,
  payoutMilli: bigint,
): MatchResult {
  assertPayout(payoutMilli);
  assertOrder(incomingOrder, payoutMilli);
  assertIncomingOrder(incomingOrder);
  if (incomingOrder.postOnly && incomingOrder.timeInForce !== "GTC") {
    throw new RangeError("postOnly orders must use GTC");
  }

  const seen = new Set<string>();
  for (const order of currentBook) {
    assertOrder(order, payoutMilli);
    if (seen.has(order.id) || order.id === incomingOrder.id) {
      throw new RangeError("order IDs must be unique");
    }
    seen.add(order.id);
  }

  const book = currentBook.map((order) => ({ ...order }));
  const firstMaker = oppositeMakers(book, incomingOrder)[0];
  const marketable = firstMaker !== undefined && crosses(incomingOrder, firstMaker);
  if (incomingOrder.postOnly && marketable) {
    return {
      disposition: "POST_ONLY_WOULD_TRADE",
      fills: [],
      restingOrders: sortBook(book),
      filledQuantity: 0,
      canceledQuantity: incomingOrder.remainingQuantity,
      remainingQuantity: 0,
      preventedOrderIds: [],
    };
  }

  if (
    incomingOrder.timeInForce === "FOK" &&
    executableQuantity(book, incomingOrder) < incomingOrder.remainingQuantity
  ) {
    return {
      disposition: "FOK_NOT_FILLABLE",
      fills: [],
      restingOrders: sortBook(book),
      filledQuantity: 0,
      canceledQuantity: incomingOrder.remainingQuantity,
      remainingQuantity: 0,
      preventedOrderIds: [],
    };
  }

  let remainingQuantity = incomingOrder.remainingQuantity;
  const fills: OrderFill[] = [];
  const preventedOrderIds: string[] = [];
  let aggressorPrevented = false;

  while (remainingQuantity > 0) {
    const maker = oppositeMakers(book, incomingOrder)[0];
    if (!maker || !crosses(incomingOrder, maker)) break;

    const makerIndex = book.findIndex((order) => order.id === maker.id);
    if (makerIndex < 0) throw new Error("book index is inconsistent");

    if (maker.stpOwnerId === incomingOrder.stpOwnerId) {
      preventedOrderIds.push(maker.id);
      if (incomingOrder.selfTradePrevention === "CANCEL_RESTING") {
        book.splice(makerIndex, 1);
        continue;
      }
      if (incomingOrder.selfTradePrevention === "CANCEL_BOTH") {
        book.splice(makerIndex, 1);
      }
      aggressorPrevented = true;
      break;
    }

    const quantity = Math.min(remainingQuantity, maker.remainingQuantity);
    fills.push({
      makerOrderId: maker.id,
      takerOrderId: incomingOrder.id,
      makerOwnerId: maker.ownerId,
      takerOwnerId: incomingOrder.ownerId,
      priceMilli: maker.limitPriceMilli,
      quantity,
    });
    remainingQuantity -= quantity;
    const makerRemaining = maker.remainingQuantity - quantity;
    if (makerRemaining === 0) {
      book.splice(makerIndex, 1);
    } else {
      book[makerIndex] = { ...maker, remainingQuantity: makerRemaining };
    }
  }

  const filledQuantity = incomingOrder.remainingQuantity - remainingQuantity;
  let canceledQuantity = 0;
  let disposition: OrderDisposition;

  if (aggressorPrevented) {
    canceledQuantity = remainingQuantity;
    remainingQuantity = 0;
    disposition = filledQuantity > 0 ? "PARTIALLY_FILLED_AND_CANCELED" : "SELF_TRADE_PREVENTED";
  } else if (remainingQuantity === 0) {
    disposition = "FILLED";
  } else if (incomingOrder.timeInForce === "GTC") {
    book.push({
      id: incomingOrder.id,
      ownerId: incomingOrder.ownerId,
      stpOwnerId: incomingOrder.stpOwnerId,
      side: incomingOrder.side,
      limitPriceMilli: incomingOrder.limitPriceMilli,
      remainingQuantity,
      prioritySequence: incomingOrder.prioritySequence,
    });
    disposition = filledQuantity > 0 ? "PARTIALLY_FILLED_AND_RESTING" : "RESTING";
  } else {
    canceledQuantity = remainingQuantity;
    remainingQuantity = 0;
    disposition = filledQuantity > 0 ? "PARTIALLY_FILLED_AND_CANCELED" : "CANCELED";
  }

  return {
    disposition,
    fills,
    restingOrders: sortBook(book),
    filledQuantity,
    canceledQuantity,
    remainingQuantity,
    preventedOrderIds,
  };
}
