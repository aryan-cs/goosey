const U64_MAX = (1n << 64n) - 1n;

function u64(value: bigint, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

/**
 * Exact conservative cash reserve used by the on-chain matching engine for a
 * newly placed BUY order (chain_notional = 0). The fee is rounded up once over
 * the full limit notional, matching cumulative fee accounting on-chain.
 */
export function buyOrderReserve(input: Readonly<{
  limitPriceMilli: bigint;
  quantity: bigint;
  feeBps: number;
}>): Readonly<{ principal: bigint; fee: bigint; requiredCash: bigint }> {
  const price = u64(input.limitPriceMilli, "order price");
  const quantity = u64(input.quantity, "order quantity");
  if (price === 0n || quantity === 0n || !Number.isInteger(input.feeBps)
    || input.feeBps < 0 || input.feeBps > 10_000) {
    throw new Error("Invalid order reserve parameters");
  }
  const principal = price * quantity;
  if (principal > U64_MAX) throw new Error("Order principal exceeds u64");
  const fee = (principal * BigInt(input.feeBps) + 9_999n) / 10_000n;
  const requiredCash = principal + fee;
  if (fee > U64_MAX || requiredCash > U64_MAX) throw new Error("Order reserve exceeds u64");
  return Object.freeze({ principal, fee, requiredCash });
}

/** Returns only the finalized cash deficit that must be deposited. */
export function orderCashDeficit(input: Readonly<{
  action: "BUY" | "SELL";
  limitPriceMilli: bigint;
  quantity: bigint;
  feeBps: number;
  availableCash: bigint;
}>): bigint {
  const availableCash = u64(input.availableCash, "available escrow cash");
  if (input.action === "SELL") return 0n;
  const { requiredCash } = buyOrderReserve(input);
  return requiredCash > availableCash ? requiredCash - availableCash : 0n;
}

