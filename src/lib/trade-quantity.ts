/** Matches the market-maker quote API's contract limit. */
export const MAX_TRADE_QUANTITY = 100_000;
export function validTradeQuantity(quantity: number): boolean {
  return Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= MAX_TRADE_QUANTITY;
}
export function tradePayoutMilli(quantity: number): bigint {
  return validTradeQuantity(quantity) ? BigInt(quantity) * 100_000n : 0n;
}
