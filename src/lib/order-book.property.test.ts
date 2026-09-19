import { describe, expect, it } from "vitest";

import {
  denormalizeYesPrice,
  matchOrder,
  normalizeToYesBook,
  type IncomingOrder,
  type OrderFill,
  type RestingOrder,
  type SelfTradePrevention,
  type TimeInForce,
} from "./order-book";

const SCENARIO_COUNT = 5_000;
const NORMALIZATION_COUNT = 10_000;

class SeededRandom {
  constructor(private state: number) {}

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  integer(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    return values[this.integer(0, values.length - 1)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compareExpected(a: RestingOrder, b: RestingOrder): number {
  if (a.side !== b.side) return a.side === "BUY" ? -1 : 1;
  if (a.limitPriceMilli !== b.limitPriceMilli) {
    if (a.side === "BUY") return a.limitPriceMilli > b.limitPriceMilli ? -1 : 1;
    return a.limitPriceMilli < b.limitPriceMilli ? -1 : 1;
  }
  if (a.prioritySequence !== b.prioritySequence) {
    return a.prioritySequence < b.prioritySequence ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function crosses(incoming: IncomingOrder, maker: RestingOrder): boolean {
  if (incoming.side === maker.side) return false;
  return incoming.side === "BUY"
    ? incoming.limitPriceMilli >= maker.limitPriceMilli
    : incoming.limitPriceMilli <= maker.limitPriceMilli;
}

function sortedMakers(book: readonly RestingOrder[], incoming: IncomingOrder): RestingOrder[] {
  return book
    .filter((order) => order.side !== incoming.side)
    .slice()
    .sort(compareExpected);
}

function externallyExecutableQuantity(
  book: readonly RestingOrder[],
  incoming: IncomingOrder,
): number {
  let quantity = 0;
  for (const maker of sortedMakers(book, incoming)) {
    if (!crosses(incoming, maker)) break;
    if (maker.stpOwnerId === incoming.stpOwnerId) {
      if (incoming.selfTradePrevention !== "CANCEL_RESTING") break;
      continue;
    }
    quantity += maker.remainingQuantity;
    if (quantity >= incoming.remainingQuantity) return incoming.remainingQuantity;
  }
  return quantity;
}

function expectedTraversal(
  book: readonly RestingOrder[],
  incoming: IncomingOrder,
): { fills: Array<Pick<OrderFill, "makerOrderId" | "priceMilli" | "quantity">>; prevented: string[] } {
  let remaining = incoming.remainingQuantity;
  const fills: Array<Pick<OrderFill, "makerOrderId" | "priceMilli" | "quantity">> = [];
  const prevented: string[] = [];

  for (const maker of sortedMakers(book, incoming)) {
    if (remaining === 0 || !crosses(incoming, maker)) break;
    if (maker.stpOwnerId === incoming.stpOwnerId) {
      prevented.push(maker.id);
      if (incoming.selfTradePrevention !== "CANCEL_RESTING") break;
      continue;
    }
    const quantity = Math.min(remaining, maker.remainingQuantity);
    fills.push({ makerOrderId: maker.id, priceMilli: maker.limitPriceMilli, quantity });
    remaining -= quantity;
  }
  return { fills, prevented };
}

function makeScenario(seed: number): {
  payout: bigint;
  book: RestingOrder[];
  incoming: IncomingOrder;
} {
  const random = new SeededRandom(seed);
  const payoutNumber = random.integer(11, 200_001);
  const payout = BigInt(payoutNumber);
  const split = random.integer(2, payoutNumber - 2);
  const owners = ["taker-stp", "stp-a", "stp-b", "stp-c", "stp-d"] as const;
  const book: RestingOrder[] = [];
  const orderCount = random.integer(0, 30);

  for (let index = 0; index < orderCount; index += 1) {
    const side = random.pick(["BUY", "SELL"] as const);
    const price = side === "BUY"
      ? random.integer(1, split - 1)
      : random.integer(split + 1, payoutNumber - 1);
    const stpOwnerId = random.pick(owners);
    book.push({
      id: `maker-${seed.toString(16)}-${index.toString().padStart(2, "0")}`,
      ownerId: `owner-${seed}-${index}`,
      stpOwnerId,
      side,
      limitPriceMilli: BigInt(price),
      remainingQuantity: random.integer(1, 50),
      prioritySequence: BigInt(random.integer(0, 12)),
    });
  }

  // Deliberately scramble insertion order; matching must depend only on price-time priority.
  book.sort(() => random.next() - 0.5);
  const timeInForce = random.pick(["GTC", "IOC", "FOK"] as const satisfies readonly TimeInForce[]);
  const incoming: IncomingOrder = {
    id: `taker-${seed.toString(16)}`,
    ownerId: `taker-owner-${seed}`,
    stpOwnerId: "taker-stp",
    side: random.pick(["BUY", "SELL"] as const),
    limitPriceMilli: BigInt(random.integer(1, payoutNumber - 1)),
    remainingQuantity: random.integer(1, 120),
    prioritySequence: BigInt(1_000_000 + seed),
    timeInForce,
    postOnly: timeInForce === "GTC" && random.chance(0.16),
    selfTradePrevention: random.pick([
      "CANCEL_AGGRESSOR",
      "CANCEL_RESTING",
      "CANCEL_BOTH",
    ] as const satisfies readonly SelfTradePrevention[]),
  };

  return { payout, book, incoming };
}

function assertSortedAndUncrossed(book: readonly RestingOrder[], seed: number): void {
  const independentlySorted = book.slice().sort(compareExpected);
  invariant(
    book.every((order, index) => order.id === independentlySorted[index]?.id),
    `seed ${seed}: residual book is not in deterministic price-time order`,
  );

  const bids = book.filter((order) => order.side === "BUY");
  const asks = book.filter((order) => order.side === "SELL");
  if (bids.length > 0 && asks.length > 0) {
    const bestBid = bids.reduce((best, order) =>
      order.limitPriceMilli > best ? order.limitPriceMilli : best, bids[0]!.limitPriceMilli);
    const bestAsk = asks.reduce((best, order) =>
      order.limitPriceMilli < best ? order.limitPriceMilli : best, asks[0]!.limitPriceMilli);
    invariant(bestBid < bestAsk, `seed ${seed}: residual book is crossed`);
  }
}

describe("order-book seeded property tests", () => {
  it(`preserves matcher invariants across ${SCENARIO_COUNT.toLocaleString("en-US")} seeded books and commands`, () => {
    for (let seed = 1; seed <= SCENARIO_COUNT; seed += 1) {
      const { payout, book, incoming } = makeScenario(seed);
      const originalBook = structuredClone(book);
      const originalIncoming = structuredClone(incoming);
      const frozenBook = Object.freeze(book.map((order) => Object.freeze({ ...order })));
      const frozenIncoming = Object.freeze({ ...incoming });

      const result = matchOrder(frozenBook, frozenIncoming, payout);
      const replay = matchOrder(frozenBook, frozenIncoming, payout);

      invariant(
        JSON.stringify(result, (_, value) => typeof value === "bigint" ? value.toString() : value) ===
          JSON.stringify(replay, (_, value) => typeof value === "bigint" ? value.toString() : value),
        `seed ${seed}: replay was not deterministic`,
      );
      expect(book).toEqual(originalBook);
      expect(incoming).toEqual(originalIncoming);
      assertSortedAndUncrossed(result.restingOrders, seed);

      const fillTotal = result.fills.reduce((total, fill) => total + fill.quantity, 0);
      invariant(fillTotal === result.filledQuantity, `seed ${seed}: fill total disagrees with result`);
      invariant(
        result.filledQuantity + result.canceledQuantity + result.remainingQuantity === incoming.remainingQuantity,
        `seed ${seed}: incoming quantity was not conserved`,
      );

      for (const fill of result.fills) {
        const maker = originalBook.find((order) => order.id === fill.makerOrderId);
        invariant(maker !== undefined, `seed ${seed}: fill references an unknown maker`);
        invariant(fill.quantity > 0, `seed ${seed}: non-positive fill`);
        invariant(fill.priceMilli === maker.limitPriceMilli, `seed ${seed}: fill did not use maker price`);
        invariant(fill.makerOwnerId === maker.ownerId, `seed ${seed}: maker owner mismatch`);
        invariant(fill.takerOrderId === incoming.id, `seed ${seed}: taker ID mismatch`);
        invariant(fill.takerOwnerId === incoming.ownerId, `seed ${seed}: taker owner mismatch`);
        invariant(maker.stpOwnerId !== incoming.stpOwnerId, `seed ${seed}: self trade executed`);
        invariant(crosses(incoming, maker), `seed ${seed}: execution violated taker price limit`);
      }

      const firstMaker = sortedMakers(originalBook, incoming)[0];
      const marketable = firstMaker !== undefined && crosses(incoming, firstMaker);
      const fokFillable = externallyExecutableQuantity(originalBook, incoming) >= incoming.remainingQuantity;
      const shortCircuited =
        (incoming.postOnly && marketable) || (incoming.timeInForce === "FOK" && !fokFillable);

      if (shortCircuited) {
        invariant(result.fills.length === 0, `seed ${seed}: rejected command produced fills`);
        invariant(result.preventedOrderIds.length === 0, `seed ${seed}: rejected command applied STP`);
        expect(result.restingOrders).toEqual(originalBook.slice().sort(compareExpected));
      } else {
        const expected = expectedTraversal(originalBook, incoming);
        expect(result.fills.map(({ makerOrderId, priceMilli, quantity }) => ({ makerOrderId, priceMilli, quantity })))
          .toEqual(expected.fills);
        expect(result.preventedOrderIds).toEqual(expected.prevented);
      }

      const removedForStp = new Set<string>();
      if (!shortCircuited) {
        if (incoming.selfTradePrevention === "CANCEL_RESTING") {
          for (const id of result.preventedOrderIds) removedForStp.add(id);
        } else if (incoming.selfTradePrevention === "CANCEL_BOTH") {
          const id = result.preventedOrderIds[0];
          if (id !== undefined) removedForStp.add(id);
        }
      }

      for (const maker of originalBook) {
        const filled = result.fills
          .filter((fill) => fill.makerOrderId === maker.id)
          .reduce((total, fill) => total + fill.quantity, 0);
        const remaining = result.restingOrders.find((order) => order.id === maker.id)?.remainingQuantity ?? 0;
        const prevented = removedForStp.has(maker.id) ? maker.remainingQuantity : 0;
        invariant(
          maker.remainingQuantity === filled + remaining + prevented,
          `seed ${seed}: maker ${maker.id} quantity was not conserved`,
        );
      }

      if (incoming.timeInForce === "IOC") {
        invariant(
          !result.restingOrders.some((order) => order.id === incoming.id),
          `seed ${seed}: IOC order rested`,
        );
      }
      if (incoming.timeInForce === "FOK") {
        invariant(
          result.filledQuantity === 0 || result.filledQuantity === incoming.remainingQuantity,
          `seed ${seed}: FOK partially filled`,
        );
        if (result.disposition === "FOK_NOT_FILLABLE") {
          expect(result.restingOrders).toEqual(originalBook.slice().sort(compareExpected));
        }
      }
      if (incoming.postOnly) {
        invariant(result.fills.length === 0, `seed ${seed}: post-only order took liquidity`);
        if (marketable) {
          invariant(result.disposition === "POST_ONLY_WOULD_TRADE", `seed ${seed}: marketable post-only accepted`);
        }
      }
    }
  }, 30_000);

  it(`round-trips ${NORMALIZATION_COUNT.toLocaleString("en-US")} seeded YES/NO prices exactly`, () => {
    const random = new SeededRandom(0x6f6f7365);
    for (let index = 0; index < NORMALIZATION_COUNT; index += 1) {
      const payout = BigInt(random.integer(2, 1_000_000));
      const price = BigInt(random.integer(1, Number(payout) - 1));
      const outcome = random.pick(["YES", "NO"] as const);
      const action = random.pick(["BUY", "SELL"] as const);
      const normalized = normalizeToYesBook(outcome, action, price, payout);

      invariant(
        denormalizeYesPrice(outcome, normalized.limitPriceMilli, payout) === price,
        `normalization case ${index}: price did not round-trip`,
      );
      invariant(
        normalized.limitPriceMilli + (payout - normalized.limitPriceMilli) === payout,
        `normalization case ${index}: complementary prices did not conserve payout`,
      );
      invariant(
        normalized.side === (outcome === "YES" ? action : action === "BUY" ? "SELL" : "BUY"),
        `normalization case ${index}: canonical side was incorrect`,
      );
    }
  });
});
