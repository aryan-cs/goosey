import { describe, expect, it } from "vitest";
import {
  assertActiveReservationConsistency,
  assertBalancedJournal,
  assertMarketQuantities,
  assertMarketSolvent,
  assertOrderBookMarketAccounting,
  assertOrderQuantityConservation,
  assertPositionReservationConsistency,
  assertTerminalMarketHasNoActiveOrders,
  assertUniqueFillJournalLinkage,
  postingSum,
} from "./invariants";
import { initialSubsidyMilli, quoteBuy } from "./market-maker";

describe("ledger invariants", () => {
  it("accepts balanced non-zero postings and rejects malformed journals", () => {
    const postings = [{ amountMilli: -10_500n }, { amountMilli: 10_000n }, { amountMilli: 500n }];
    expect(postingSum(postings)).toBe(0n);
    expect(() => assertBalancedJournal(postings)).not.toThrow();
    expect(() => assertBalancedJournal([{ amountMilli: -1n }, { amountMilli: 2n }])).toThrow(/balance/);
    expect(() => assertBalancedJournal([{ amountMilli: 0n }, { amountMilli: 0n }])).toThrow(/non-zero/);
  });

  it("reconciles aggregate positions to market quantities", () => {
    const positions = [{ yesShares: 4, noShares: 1 }, { yesShares: 7, noShares: 9 }];
    expect(() => assertMarketQuantities({ yesQuantity: 11, noQuantity: 10 }, positions)).not.toThrow();
    expect(() => assertMarketQuantities({ yesQuantity: 10, noQuantity: 10 }, positions)).toThrow(/aggregate/);
  });

  it("keeps LMSR collateral solvent across a buy", () => {
    const state = { yesQuantity: 0, noQuantity: 0, liquidity: 40 };
    const collateral = initialSubsidyMilli(state.liquidity);
    const quote = quoteBuy(state, "YES", 25);
    expect(() => assertMarketSolvent(quote.stateAfter, collateral + quote.grossMilli)).not.toThrow();
    expect(() => assertMarketSolvent(quote.stateAfter, 1n)).toThrow(/collateral/);
  });

  it("conserves every order quantity", () => {
    expect(() => assertOrderQuantityConservation({
      originalQuantity: 10,
      remainingQuantity: 3,
      filledQuantity: 5,
      canceledQuantity: 2,
    })).not.toThrow();
    expect(() => assertOrderQuantityConservation({
      originalQuantity: 10,
      remainingQuantity: 3,
      filledQuantity: 5,
      canceledQuantity: 1,
    })).toThrow(/conserved/);
    expect(() => assertOrderQuantityConservation({
      originalQuantity: 10,
      remainingQuantity: -1,
      filledQuantity: 11,
      canceledQuantity: 0,
    })).toThrow(/non-negative/);
  });

  it("reconciles active order reservation records and caches", () => {
    const order = {
      userId: "user-1",
      marketId: "market-1",
      action: "BUY",
      outcome: "YES",
      status: "OPEN",
      remainingQuantity: 4,
      reservedCashMilli: 202_000n,
      reservedFeeMilli: 2_000n,
      reservedShares: 0,
    };
    const reservation = {
      userId: "user-1",
      marketId: "market-1",
      reservedPrincipalMilli: 200_000n,
      reservedFeeMilli: 2_000n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
    };
    expect(() => assertActiveReservationConsistency(order, reservation)).not.toThrow();
    expect(() => assertActiveReservationConsistency(order, null)).toThrow(/missing/);
    expect(() => assertActiveReservationConsistency(
      { ...order, reservedCashMilli: 201_999n },
      reservation,
    )).toThrow(/caches/);
    expect(() => assertActiveReservationConsistency(
      { ...order, status: "FILLED", remainingQuantity: 0 },
      reservation,
    )).toThrow(/Inactive/);
  });

  describe.each(["YES", "NO"])("SELL %s backing", (outcome) => {
    function fixture(selected: number, opposite = 0, status = "OPEN") {
      return {
        order: {
          userId: "user-1", marketId: "market-1", action: "SELL", outcome, status,
          originalQuantity: 10, filledQuantity: status === "PARTIALLY_FILLED" ? 6 : 0,
          canceledQuantity: 0, remainingQuantity: status === "PARTIALLY_FILLED" ? 4 : 10,
          reservedCashMilli: 0n, reservedFeeMilli: 0n, reservedShares: selected + opposite,
        },
        reservation: {
          userId: "user-1", marketId: "market-1", reservedPrincipalMilli: 0n, reservedFeeMilli: 0n,
          reservedYesQuantity: outcome === "YES" ? selected : opposite,
          reservedNoQuantity: outcome === "NO" ? selected : opposite,
        },
      };
    }

    it("accepts exact open and partially-filled backing for only the unfilled quantity", () => {
      for (const [quantity, status] of [[10, "OPEN"], [4, "PARTIALLY_FILLED"]] as const) {
        const { order, reservation } = fixture(quantity, 0, status);
        expect(() => assertOrderQuantityConservation(order)).not.toThrow();
        expect(() => assertActiveReservationConsistency(order, reservation)).not.toThrow();
      }
    });

    it.each([
      ["under-reserved", 1, 0], ["over-reserved", 11, 0],
      ["wrong outcome", 0, 10], ["both outcomes", 10, 1],
    ] as const)("rejects %s backing even when the reservation caches agree", (_label, selected, opposite) => {
      const { order, reservation } = fixture(selected, opposite);
      expect(() => assertActiveReservationConsistency(order, reservation)).toThrow(/Active SELL reservation/);
    });

    it("rejects partial-fill backing that still reserves the original quantity", () => {
      const { order, reservation } = fixture(10, 0, "PARTIALLY_FILLED");
      expect(() => assertActiveReservationConsistency(order, reservation)).toThrow(/Active SELL reservation/);
    });
  });

  it("reconciles reserved shares to positions without overselling", () => {
    const position = {
      userId: "user-1",
      marketId: "market-1",
      yesShares: 8,
      noShares: 4,
      reservedYesShares: 3,
      reservedNoShares: 1,
    };
    const reservations = [{
      userId: "user-1",
      marketId: "market-1",
      reservedPrincipalMilli: 0n,
      reservedFeeMilli: 0n,
      reservedYesQuantity: 3,
      reservedNoQuantity: 1,
    }];
    expect(() => assertPositionReservationConsistency(position, reservations)).not.toThrow();
    expect(() => assertPositionReservationConsistency(
      { ...position, reservedYesShares: 9 },
      reservations,
    )).toThrow(/exceed/);
    expect(() => assertPositionReservationConsistency(
      { ...position, reservedYesShares: 2 },
      reservations,
    )).toThrow(/caches/);
  });

  it("requires each fill to have a unique journal", () => {
    expect(() => assertUniqueFillJournalLinkage([
      { journalEntryId: "journal-1" },
      { journalEntryId: "journal-2" },
    ])).not.toThrow();
    expect(() => assertUniqueFillJournalLinkage([
      { journalEntryId: "journal-1" },
      { journalEntryId: "journal-1" },
    ])).toThrow(/same journal/);
    expect(() => assertUniqueFillJournalLinkage([{ journalEntryId: "" }])).toThrow(/missing/);
  });

  it("requires exact complete-set supply and collateral for order-book markets", () => {
    expect(() => assertOrderBookMarketAccounting({
      yesShares: 7,
      noShares: 7,
      payoutMilli: 100_000n,
      collateralMilli: 700_000n,
    })).not.toThrow();
    expect(() => assertOrderBookMarketAccounting({
      yesShares: 7,
      noShares: 6,
      payoutMilli: 100_000n,
      collateralMilli: 700_000n,
    })).toThrow(/equal/);
    expect(() => assertOrderBookMarketAccounting({
      yesShares: 7,
      noShares: 7,
      payoutMilli: 100_000n,
      collateralMilli: 699_999n,
    })).toThrow(/exactly/);
  });

  it("forbids active orders and reservations on terminal markets", () => {
    const activeOrder = { status: "OPEN", remainingQuantity: 1 };
    const activeReservation = {
      userId: "user-1",
      marketId: "market-1",
      reservedPrincipalMilli: 1n,
      reservedFeeMilli: 0n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
    };
    expect(() => assertTerminalMarketHasNoActiveOrders({
      status: "OPEN",
      orders: [activeOrder],
      reservations: [activeReservation],
    })).not.toThrow();
    expect(() => assertTerminalMarketHasNoActiveOrders({
      status: "RESOLVED",
      orders: [activeOrder],
      reservations: [],
    })).toThrow(/active orders/);
    expect(() => assertTerminalMarketHasNoActiveOrders({
      status: "VOID",
      orders: [{ status: "CANCELED", remainingQuantity: 0 }],
      reservations: [activeReservation],
    })).toThrow(/active reservations/);
  });
});
