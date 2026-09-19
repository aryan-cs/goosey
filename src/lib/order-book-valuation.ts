import type { Market, MarketOrder, Position } from "@prisma/client";

import { cumulativeFeeMilli } from "./order-book-accounting";
import { sweepPriceLevels, type PriceLevel } from "./order-book-pricing";

export type ValuationOrder = Pick<
  MarketOrder,
  "userId" | "stpOwnerId" | "bookSide" | "limitPriceMilli" | "remainingQuantity" | "status" | "expiresAt"
>;

type ValuationMarket = Pick<
  Market,
  "payoutMilli" | "feeBps" | "status" | "resolution" | "closesAt" | "acceptingOrders"
>;

type ValuationPosition = Pick<Position, "userId" | "yesShares" | "noShares">;

export interface OrderBookPositionValue {
  yes: bigint;
  no: bigint;
  valueMilli: bigint;
  unfilledYes: number;
  unfilledNo: number;
}

function result(yes: bigint, no: bigint, unfilledYes = 0, unfilledNo = 0): OrderBookPositionValue {
  return { yes, no, valueMilli: yes + no, unfilledYes, unfilledNo };
}

function activeExternalLevels(
  orders: readonly ValuationOrder[],
  positionUserId: string,
  bookSide: "BUY" | "SELL",
  now: Date,
): PriceLevel[] {
  return orders
    .filter((order) =>
      order.userId !== positionUserId &&
      order.stpOwnerId !== positionUserId &&
      order.bookSide === bookSide &&
      (order.status === "OPEN" || order.status === "PARTIALLY_FILLED") &&
      order.remainingQuantity > 0 &&
      (order.expiresAt === null || order.expiresAt > now)
    )
    .map((order) => ({
      priceMilli: order.limitPriceMilli,
      quantity: BigInt(order.remainingQuantity),
    }));
}

function netLiquidationValue(grossMilli: bigint, feeBps: number): bigint {
  const feeMilli = cumulativeFeeMilli(grossMilli, BigInt(feeBps));
  return grossMilli > feeMilli ? grossMilli - feeMilli : 0n;
}

/**
 * Conservatively values an order-book position as if the user's own open
 * orders were cancelled before liquidating against currently executable depth.
 */
export function valueOrderBookPosition(input: {
  market: ValuationMarket;
  position: ValuationPosition;
  orders: readonly ValuationOrder[];
  now: Date;
}): OrderBookPositionValue {
  const { market, position, orders, now } = input;
  if (market.payoutMilli <= 0n) throw new RangeError("payoutMilli must be positive");
  if (!Number.isInteger(market.feeBps) || market.feeBps < 0 || market.feeBps > 10_000) {
    throw new RangeError("feeBps must be an integer between zero and 10000");
  }
  if (!Number.isInteger(position.yesShares) || position.yesShares < 0 || !Number.isInteger(position.noShares) || position.noShares < 0) {
    throw new RangeError("position shares must be non-negative integers");
  }

  const yesShares = BigInt(position.yesShares);
  const noShares = BigInt(position.noShares);

  if (market.status === "VOID") {
    const total = ((yesShares + noShares) * market.payoutMilli) / 2n;
    const yes = (yesShares * market.payoutMilli) / 2n;
    return result(yes, total - yes);
  }

  // Approval fixes the outcome before batched payouts finish. Unpaid holdings
  // remain settlement claims while RESOLVING, not unavailable trading depth.
  if (market.status === "RESOLVED" || market.status === "RESOLVING") {
    if (market.resolution === "YES") return result(yesShares * market.payoutMilli, 0n);
    if (market.resolution === "NO") return result(0n, noShares * market.payoutMilli);
    if (market.resolution === "VOID") {
      const total = ((yesShares + noShares) * market.payoutMilli) / 2n;
      const yes = (yesShares * market.payoutMilli) / 2n;
      return result(yes, total - yes);
    }
    return result(0n, 0n);
  }

  const paired = yesShares < noShares ? yesShares : noShares;
  const yesPairValue = paired * (market.payoutMilli / 2n);
  const noPairValue = paired * (market.payoutMilli - market.payoutMilli / 2n);
  const remainingYes = yesShares - paired;
  const remainingNo = noShares - paired;
  const canLiquidate =
    market.status === "OPEN" &&
    market.acceptingOrders &&
    market.closesAt > now;

  if (!canLiquidate) {
    return result(yesPairValue, noPairValue, Number(remainingYes), Number(remainingNo));
  }

  let yesLiquidation = 0n;
  let noLiquidation = 0n;
  let unfilledYes = remainingYes;
  let unfilledNo = remainingNo;

  if (remainingYes > 0n) {
    const bids = activeExternalLevels(orders, position.userId, "BUY", now);
    const sweep = sweepPriceLevels(bids, "BID", remainingYes, market.payoutMilli);
    yesLiquidation = netLiquidationValue(sweep.grossMilli, market.feeBps);
    unfilledYes = sweep.unfilledQuantity;
  }

  if (remainingNo > 0n) {
    const complementedAsks = activeExternalLevels(orders, position.userId, "SELL", now)
      .map((level) => ({
        priceMilli: market.payoutMilli - level.priceMilli,
        quantity: level.quantity,
      }));
    const sweep = sweepPriceLevels(complementedAsks, "BID", remainingNo, market.payoutMilli);
    noLiquidation = netLiquidationValue(sweep.grossMilli, market.feeBps);
    unfilledNo = sweep.unfilledQuantity;
  }

  return result(
    yesPairValue + yesLiquidation,
    noPairValue + noLiquidation,
    Number(unfilledYes),
    Number(unfilledNo),
  );
}
