import { cumulativeFeeMilli, FEE_BASIS_POINTS } from "./order-book-accounting";
import { ORDER_BOOK_LIMITS } from "./order-book";

export type OrderEntryResult =
  | {
      valid: true;
      priceMilli: bigint;
      grossMilli: bigint;
      feeMilli: bigint;
      cashMilli: bigint;
    }
  | { valid: false; message: string };

const decimalPrice = /^(?:0|[1-9]\d*)(?:\.(\d{1,3}))?$/;

function invalid(message: string): OrderEntryResult {
  return { valid: false, message };
}

/** Parse an order ticket without floating-point or unsafe bigint conversion. */
export function parseOrderEntry(
  price: string,
  quantity: number,
  payoutMilli: bigint,
  feeBps: number,
  action: "BUY" | "SELL",
): OrderEntryResult {
  if (
    typeof payoutMilli !== "bigint" ||
    payoutMilli < 2n ||
    payoutMilli > ORDER_BOOK_LIMITS.maxPayoutMilli
  ) {
    return invalid("The market payout is invalid.");
  }
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > Number(FEE_BASIS_POINTS)) {
    return invalid("The market fee is invalid.");
  }
  if (action !== "BUY" && action !== "SELL") {
    return invalid("The order action is invalid.");
  }
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > ORDER_BOOK_LIMITS.maxQuantity) {
    return invalid(`Enter a whole quantity from 1 to ${ORDER_BOOK_LIMITS.maxQuantity}.`);
  }
  if (typeof price !== "string" || price.length > 64) {
    return invalid("Enter a price with no more than three decimal places.");
  }
  const match = decimalPrice.exec(price);
  if (!match) {
    return invalid("Enter a price with no more than three decimal places.");
  }

  const [whole, fraction = ""] = price.split(".");
  const priceMilli = BigInt(whole) * 1_000n + BigInt(fraction.padEnd(3, "0") || "0");
  if (priceMilli <= 0n || priceMilli >= payoutMilli) {
    return invalid("Enter a price above zero and below the market payout.");
  }

  const grossMilli = priceMilli * BigInt(quantity);
  const feeMilli = cumulativeFeeMilli(grossMilli, BigInt(feeBps));
  return {
    valid: true,
    priceMilli,
    grossMilli,
    feeMilli,
    cashMilli: action === "BUY" ? grossMilli + feeMilli : grossMilli - feeMilli,
  };
}

export function orderEntryHref(
  slug: string,
  outcome: "YES" | "NO",
  action: "BUY" | "SELL",
): string {
  return `/markets/${encodeURIComponent(slug)}?outcome=${outcome}&action=${action}#order-book`;
}
