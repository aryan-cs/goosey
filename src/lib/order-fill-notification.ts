import type { OrderIntent } from "./order-book-accounting";

export function notificationFeathers(milli: bigint): string {
  const fraction = (milli % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${milli / 1000n}${fraction ? `.${fraction}` : ""}`;
}

/** Describe the participant's own contract, never the canonical YES book price for NO. */
export function orderFillNotification(input: {
  userId: string;
  intent: OrderIntent;
  quantity: number;
  canonicalYesPriceMilli: bigint;
  payoutMilli: bigint;
  feeMilli: bigint;
  marketSlug: string;
  marketTitle: string;
  executedAt: Date;
}) {
  const price = input.intent.outcome === "YES"
    ? input.canonicalYesPriceMilli
    : input.payoutMilli - input.canonicalYesPriceMilli;
  return {
    userId: input.userId,
    type: "TRADE_CONFIRMED",
    title: `${input.intent.action === "BUY" ? "Bought" : "Sold"} ${input.quantity} ${input.intent.outcome}`,
    body: `${input.marketTitle}: filled at ${notificationFeathers(price)} feathers per contract. Fee: ${notificationFeathers(input.feeMilli)} feathers.`,
    href: `/markets/${input.marketSlug}`,
    createdAt: input.executedAt,
  };
}
