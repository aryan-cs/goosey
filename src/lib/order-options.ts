export type OrderTimeInForce = "GTC" | "IOC" | "FOK";

export type OrderOptionsResult =
  | { valid: true; timeInForce: OrderTimeInForce; postOnly: boolean; expiresAt: string | null }
  | { valid: false; message: string };

export function parseOrderOptions(
  input: { timeInForce: unknown; postOnly: unknown; expiresAtLocal: string },
  now: Date = new Date(),
): OrderOptionsResult {
  const { timeInForce, postOnly, expiresAtLocal } = input;
  if (timeInForce !== "GTC" && timeInForce !== "IOC" && timeInForce !== "FOK") {
    return { valid: false, message: "Choose GTC, IOC, or FOK for time in force." };
  }
  if (typeof postOnly !== "boolean") return { valid: false, message: "Post-only must be on or off." };
  if (typeof expiresAtLocal !== "string") return { valid: false, message: "Enter a valid local expiration date and time." };
  if (timeInForce !== "GTC" && (postOnly || expiresAtLocal !== "")) {
    return { valid: false, message: "Post-only and expiration are available only for GTC orders." };
  }
  if (expiresAtLocal === "") return { valid: true, timeInForce, postOnly, expiresAt: null };

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(expiresAtLocal);
  if (!match) return { valid: false, message: "Use YYYY-MM-DDTHH:mm for the local expiration time." };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  // ISO datetime without an offset is interpreted in the participant's local
  // timezone. Round-trip each field to reject normalization and DST gaps.
  const date = new Date(expiresAtLocal);
  if (
    year < 1 || !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year || date.getMonth() + 1 !== month ||
    date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute
  ) {
    return { valid: false, message: "Choose a real local date and time (not a daylight-saving clock gap)." };
  }
  if (!Number.isFinite(now.getTime()) || date.getTime() <= now.getTime()) {
    return { valid: false, message: "Expiration must be in the future." };
  }
  return { valid: true, timeInForce, postOnly, expiresAt: date.toISOString() };
}

const unknownStatusMessage = "Order status could not be confirmed. Refresh your orders before trying again.";

export function orderPlacementMessage(order: {
  status: string;
  filledQuantity: number;
  remainingQuantity: number;
  canceledQuantity?: number;
}): string {
  if ([order.filledQuantity, order.remainingQuantity, ...(order.canceledQuantity === undefined ? [] : [order.canceledQuantity])]
    .some((quantity) => !Number.isSafeInteger(quantity) || quantity < 0)) return unknownStatusMessage;
  const contracts = (quantity: number) => `${quantity} contract${quantity === 1 ? "" : "s"}`;
  switch (order.status) {
    case "FILLED": return "Order filled.";
    case "OPEN": return "Limit order placed. You can cancel its unfilled quantity below.";
    case "PARTIALLY_FILLED": return `${contracts(order.filledQuantity)} filled. ${contracts(order.remainingQuantity)} remain open; you can cancel the unfilled quantity below.`;
    case "CANCELED": {
      if (order.filledQuantity === 0) return "Order canceled without any fills. No quantity remains open.";
      const canceled = order.canceledQuantity === undefined
        ? "The unfilled remainder was canceled."
        : `${contracts(order.canceledQuantity)} canceled.`;
      return `${contracts(order.filledQuantity)} filled. ${canceled} No quantity remains open.`;
    }
    case "EXPIRED": return order.filledQuantity > 0
      ? `Order expired after ${contracts(order.filledQuantity)} filled. No quantity remains open.`
      : "Order expired without any fills. No quantity remains open.";
    default: return unknownStatusMessage;
  }
}

export function orderRejectionMessage(reason: string): string {
  switch (reason) {
    // The matcher currently returns the descriptive codes; accept the short
    // REJECT_* names too so either boundary representation has useful copy.
    case "REJECT_FOK":
    case "FOK_NOT_FILLABLE": return "Fill-or-kill order rejected: the full quantity could not fill immediately at your limit price. Nothing was filled.";
    case "REJECT_POST_ONLY":
    case "POST_ONLY_WOULD_TRADE": return "Post-only order rejected: it would trade immediately. Choose a price that rests on the book or turn off post-only.";
    default: return "The order was not accepted. Review your order details and try again.";
  }
}
