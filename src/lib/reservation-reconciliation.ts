type CashAccount = { id: string; ownerType: string; ownerId: string | null; purpose: string; balanceMilli: bigint };
type CashReservation = { orderId: string; cashAccountId: string | null; reservedPrincipalMilli: bigint; reservedFeeMilli: bigint };

/** Independently compare persisted reservation claims with their actual escrow. */
export function reconcileReservationCash(accounts: readonly CashAccount[], reservations: readonly CashReservation[]): string[] {
  const errors: string[] = [];
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const used = new Set<string>();
  for (const reservation of reservations) {
    const expected = reservation.reservedPrincipalMilli + reservation.reservedFeeMilli;
    if (reservation.reservedPrincipalMilli < 0n || reservation.reservedFeeMilli < 0n) {
      errors.push(`order ${reservation.orderId} has negative cash reservations`);
    }
    if (!reservation.cashAccountId) {
      if (expected !== 0n) errors.push(`order ${reservation.orderId} reserves cash without an escrow account`);
      continue;
    }
    if (used.has(reservation.cashAccountId)) errors.push(`order ${reservation.orderId} shares an escrow account`);
    used.add(reservation.cashAccountId);
    const account = byId.get(reservation.cashAccountId);
    if (!account) {
      errors.push(`order ${reservation.orderId} escrow account is missing`);
      continue;
    }
    if (account.ownerType !== "ORDER" || account.ownerId !== reservation.orderId || account.purpose !== "ORDER_RESERVE") {
      errors.push(`order ${reservation.orderId} escrow ownership is incorrect`);
    }
    if (account.balanceMilli !== expected) errors.push(`order ${reservation.orderId} escrow balance does not match reserved principal and fees`);
  }
  for (const account of accounts) {
    if (account.purpose === "ORDER_RESERVE" && account.balanceMilli !== 0n && !used.has(account.id)) {
      errors.push(`escrow account ${account.id} has cash without a reservation`);
    }
  }
  return errors;
}
