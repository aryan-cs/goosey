import { requiredCollateralMilli, type MarketMakerState } from "@/lib/market-maker";

export interface PostingLike { amountMilli: bigint }
export interface PositionLike { yesShares: number; noShares: number }
export interface OrderQuantityLike {
  originalQuantity: number;
  remainingQuantity: number;
  filledQuantity: number;
  canceledQuantity: number;
}
export interface OrderReservationLike {
  userId: string;
  marketId: string;
  reservedPrincipalMilli: bigint;
  reservedFeeMilli: bigint;
  reservedYesQuantity: number;
  reservedNoQuantity: number;
}
export interface ReservableOrderLike {
  userId: string;
  marketId: string;
  status: string;
  remainingQuantity: number;
  reservedCashMilli: bigint;
  reservedFeeMilli: bigint;
  reservedShares: number;
}
export interface ReservablePositionLike extends PositionLike {
  userId: string;
  marketId: string;
  reservedYesShares: number;
  reservedNoShares: number;
}
export interface FillJournalLike { journalEntryId: string }

export const ACTIVE_ORDER_STATUSES = new Set(["OPEN", "PARTIALLY_FILLED"]);
export const TERMINAL_MARKET_STATUSES = new Set(["RESOLVED", "VOID"]);

export function postingSum(postings: PostingLike[]): bigint {
  return postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
}

export function assertBalancedJournal(postings: PostingLike[]): void {
  if (postings.length < 2 || postings.some((posting) => posting.amountMilli === 0n)) {
    throw new Error("A journal requires at least two non-zero postings.");
  }
  if (postingSum(postings) !== 0n) throw new Error("Journal postings do not balance.");
}

export function aggregatePositions(positions: PositionLike[]) {
  return positions.reduce(
    (totals, position) => ({
      yesShares: totals.yesShares + position.yesShares,
      noShares: totals.noShares + position.noShares,
    }),
    { yesShares: 0, noShares: 0 },
  );
}

export function assertMarketQuantities(
  market: Pick<MarketMakerState, "yesQuantity" | "noQuantity">,
  positions: PositionLike[],
): void {
  const totals = aggregatePositions(positions);
  if (totals.yesShares !== market.yesQuantity || totals.noShares !== market.noQuantity) {
    throw new Error("Market quantities do not match aggregate positions.");
  }
}

export function assertMarketSolvent(state: MarketMakerState, collateralMilli: bigint): void {
  if (collateralMilli < requiredCollateralMilli(state)) {
    throw new Error("Market collateral is below maximum resolution liability.");
  }
}

export function assertOrderQuantityConservation(order: OrderQuantityLike): void {
  const quantities = [
    order.originalQuantity,
    order.remainingQuantity,
    order.filledQuantity,
    order.canceledQuantity,
  ];
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity) || quantity < 0)) {
    throw new Error("Order quantities must be non-negative safe integers.");
  }
  if (
    order.originalQuantity !==
    order.remainingQuantity + order.filledQuantity + order.canceledQuantity
  ) {
    throw new Error("Order quantity is not conserved.");
  }
}

export function assertActiveReservationConsistency(
  order: ReservableOrderLike,
  reservation: OrderReservationLike | null | undefined,
): void {
  const active = ACTIVE_ORDER_STATUSES.has(order.status) && order.remainingQuantity > 0;
  const cachedAmounts = [order.reservedCashMilli, order.reservedFeeMilli];
  if (
    cachedAmounts.some((amount) => amount < 0n) ||
    !Number.isSafeInteger(order.reservedShares) ||
    order.reservedShares < 0
  ) {
    throw new Error("Order reservation caches cannot be negative.");
  }

  if (!reservation) {
    if (active) throw new Error("Active order is missing its reservation.");
    if (order.reservedCashMilli !== 0n || order.reservedFeeMilli !== 0n || order.reservedShares !== 0) {
      throw new Error("Inactive order retains a reservation cache.");
    }
    return;
  }

  if (reservation.userId !== order.userId || reservation.marketId !== order.marketId) {
    throw new Error("Order reservation ownership does not match its order.");
  }
  if (
    reservation.reservedPrincipalMilli < 0n ||
    reservation.reservedFeeMilli < 0n ||
    !Number.isSafeInteger(reservation.reservedYesQuantity) ||
    !Number.isSafeInteger(reservation.reservedNoQuantity) ||
    reservation.reservedYesQuantity < 0 ||
    reservation.reservedNoQuantity < 0
  ) {
    throw new Error("Order reservation amounts cannot be negative.");
  }

  const reservationCash = reservation.reservedPrincipalMilli + reservation.reservedFeeMilli;
  const reservationShares = reservation.reservedYesQuantity + reservation.reservedNoQuantity;
  if (
    order.reservedCashMilli !== reservationCash ||
    order.reservedFeeMilli !== reservation.reservedFeeMilli ||
    order.reservedShares !== reservationShares
  ) {
    throw new Error("Order reservation caches do not match the reservation record.");
  }

  const hasReservation = reservationCash > 0n || reservationShares > 0;
  if (active && !hasReservation) throw new Error("Active order has an empty reservation.");
  if (!active && hasReservation) throw new Error("Inactive order retains an active reservation.");
}

export function assertPositionReservationConsistency(
  position: ReservablePositionLike,
  reservations: readonly OrderReservationLike[],
): void {
  if (
    !Number.isSafeInteger(position.reservedYesShares) ||
    !Number.isSafeInteger(position.reservedNoShares) ||
    position.reservedYesShares < 0 ||
    position.reservedNoShares < 0 ||
    position.reservedYesShares > position.yesShares ||
    position.reservedNoShares > position.noShares
  ) {
    throw new Error("Reserved shares exceed the position.");
  }

  const active = reservations.filter(
    (reservation) => reservation.userId === position.userId && reservation.marketId === position.marketId,
  );
  const reservedYes = active.reduce((total, reservation) => total + reservation.reservedYesQuantity, 0);
  const reservedNo = active.reduce((total, reservation) => total + reservation.reservedNoQuantity, 0);
  if (reservedYes !== position.reservedYesShares || reservedNo !== position.reservedNoShares) {
    throw new Error("Position reservation caches do not match active order reservations.");
  }
}

export function assertUniqueFillJournalLinkage(fills: readonly FillJournalLike[]): void {
  const journalIds = new Set<string>();
  for (const fill of fills) {
    if (!fill.journalEntryId) throw new Error("Order fill is missing its journal linkage.");
    if (journalIds.has(fill.journalEntryId)) {
      throw new Error("Multiple order fills reference the same journal.");
    }
    journalIds.add(fill.journalEntryId);
  }
}

export function assertOrderBookMarketAccounting(input: {
  yesShares: number;
  noShares: number;
  payoutMilli: bigint;
  collateralMilli: bigint;
}): void {
  if (input.yesShares !== input.noShares) {
    throw new Error("Order-book YES and NO supply must be equal.");
  }
  const expectedCollateral = BigInt(input.yesShares) * input.payoutMilli;
  if (input.collateralMilli !== expectedCollateral) {
    throw new Error("Order-book collateral does not exactly match complete-set supply.");
  }
}

export function assertTerminalMarketHasNoActiveOrders(input: {
  status: string;
  orders: readonly Pick<ReservableOrderLike, "status" | "remainingQuantity">[];
  reservations: readonly OrderReservationLike[];
}): void {
  if (!TERMINAL_MARKET_STATUSES.has(input.status)) return;
  if (
    input.orders.some(
      (order) => ACTIVE_ORDER_STATUSES.has(order.status) && order.remainingQuantity > 0,
    )
  ) {
    throw new Error("Terminal market has active orders.");
  }
  if (
    input.reservations.some(
      (reservation) =>
        reservation.reservedPrincipalMilli > 0n ||
        reservation.reservedFeeMilli > 0n ||
        reservation.reservedYesQuantity > 0 ||
        reservation.reservedNoQuantity > 0,
    )
  ) {
    throw new Error("Terminal market has active reservations.");
  }
}
