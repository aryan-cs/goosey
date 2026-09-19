import type { Market, Position } from "@prisma/client";
import { computeQuote, executablePositionValue, yesProbabilityBps } from "@/lib/trading";

type PositionWithMarket = Position & { market: Market };

export function liquidationValueMilli(position: PositionWithMarket): bigint {
  return executablePositionValue(position.market, position);
}

export function sideLiquidationValuesMilli(position: PositionWithMarket): { yes: bigint; no: bigint } {
  const pairs = Math.min(position.yesShares, position.noShares);
  const remainingYes = position.yesShares - pairs;
  const remainingNo = position.noShares - pairs;
  let yes = 0n;
  let no = 0n;
  if (position.market.status === "RESOLVED") {
    if (position.market.resolution === "YES") yes = BigInt(position.yesShares) * position.market.payoutMilli;
    if (position.market.resolution === "NO") no = BigInt(position.noShares) * position.market.payoutMilli;
    return { yes, no };
  }
  if (position.market.status === "VOID") {
    return { yes: BigInt(position.yesShares) * position.market.payoutMilli / 2n, no: BigInt(position.noShares) * position.market.payoutMilli / 2n };
  }
  const pairValue = BigInt(pairs) * position.market.payoutMilli;
  const yesBps = BigInt(yesProbabilityBps(position.market.yesShares, position.market.noShares, position.market.liquidityParameter));
  const pairedYesValue = pairValue * yesBps / 10_000n;
  yes = pairedYesValue;
  no = pairValue - pairedYesValue;
  if (remainingYes > 0) yes += computeQuote(position.market, "YES", "SELL", remainingYes).netCreditMilli!;
  if (remainingNo > 0) no += computeQuote(position.market, "NO", "SELL", remainingNo).netCreditMilli!;
  return { yes, no };
}
