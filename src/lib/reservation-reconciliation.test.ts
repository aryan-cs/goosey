import { describe, expect, it } from "vitest";
import { reconcileReservationCash } from "./reservation-reconciliation";

const account = { id: "escrow", ownerType: "ORDER", ownerId: "order", purpose: "ORDER_RESERVE", balanceMilli: 101n };
const reservation = { orderId: "order", cashAccountId: "escrow", reservedPrincipalMilli: 100n, reservedFeeMilli: 1n };

describe("independent escrow reconciliation", () => {
  it("accepts exact principal plus fees and released reserves", () => {
    expect(reconcileReservationCash([account], [reservation])).toEqual([]);
    expect(reconcileReservationCash([{ ...account, balanceMilli: 0n }], [{ ...reservation, reservedPrincipalMilli: 0n, reservedFeeMilli: 0n }])).toEqual([]);
    expect(reconcileReservationCash([], [{ ...reservation, cashAccountId: null, reservedPrincipalMilli: 0n, reservedFeeMilli: 0n }])).toEqual([]);
  });
  it("detects missing or insufficient escrow even if other ledger caches balance", () => {
    expect(reconcileReservationCash([], [reservation])).toContain("order order escrow account is missing");
    expect(reconcileReservationCash([{ ...account, balanceMilli: 100n }], [reservation])).toContain("order order escrow balance does not match reserved principal and fees");
    expect(reconcileReservationCash([], [{ ...reservation, cashAccountId: null }])).toContain("order order reserves cash without an escrow account");
  });
  it("detects ownership and shared-account errors", () => {
    expect(reconcileReservationCash([{ ...account, ownerId: "someone-else" }], [reservation])).toContain("order order escrow ownership is incorrect");
    expect(reconcileReservationCash([account], [reservation, { ...reservation, orderId: "second" }])).toContain("order second shares an escrow account");
  });
  it("detects orphan cash and negative reservation fields", () => {
    expect(reconcileReservationCash([account], [])).toContain("escrow account escrow has cash without a reservation");
    expect(reconcileReservationCash([account], [{ ...reservation, reservedPrincipalMilli: -1n, reservedFeeMilli: 102n }])).toContain("order order has negative cash reservations");
  });
});
