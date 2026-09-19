import { BASIS_POINTS, settlementPayoutMilli, VOID_PAYOUT_BPS } from "@/lib/market-maker";

/** Position limits apply to each outcome, not their combined contract count. */
export function positionSettlementPayoutMilli(
  position: { yesShares: number; noShares: number },
  outcome: string,
  payoutMilli: bigint,
): bigint {
  const yes = settlementPayoutMilli(position.yesShares, payoutMilli);
  const no = settlementPayoutMilli(position.noShares, payoutMilli);
  if (outcome === "YES") return yes;
  if (outcome === "NO") return no;
  // Divide once after combining exact numerators. Rounding each outcome first
  // would underpay a complete pair when a legacy payout is indivisible.
  if (outcome === "VOID") return ((yes + no) * BigInt(VOID_PAYOUT_BPS)) / BigInt(BASIS_POINTS);
  throw new Error(`Unsupported settlement outcome ${outcome}`);
}
