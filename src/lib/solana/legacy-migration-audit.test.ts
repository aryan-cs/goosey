import { describe, expect, it } from "vitest";

import {
  SOLANA_U64_MAX,
  buildLegacyMigrationSnapshot,
  canonicalLegacyMigrationSnapshotJson,
  type LegacyLedgerAccount,
  type LegacyMigrationAuditInput,
  type LegacyMigrationMarket,
  type LegacyMigrationOrder,
  type LegacyMigrationPosition,
} from "./legacy-migration-audit";

function ledger(id: string, ownerType: string, ownerId: string, purpose: string, balanceMilli: bigint): LegacyLedgerAccount {
  return { id, ownerType, ownerId, purpose, balanceMilli, status: "ACTIVE", postings: balanceMilli === 0n ? [] : [{ amountMilli: balanceMilli, journalStatus: "POSTED" }] };
}

function position(overrides: Partial<LegacyMigrationPosition> = {}): LegacyMigrationPosition {
  return {
    userId: "user-a",
    marketId: "market-a",
    yesShares: 10,
    noShares: 10,
    reservedYesShares: 0,
    reservedNoShares: 0,
    netCostMilli: 1_000n,
    yesCostBasisMilli: 600n,
    noCostBasisMilli: 400n,
    realizedPnlMilli: -25n,
    ...overrides,
  };
}

function order(overrides: Partial<LegacyMigrationOrder> = {}): LegacyMigrationOrder {
  const cash = ledger("reserve-a", "ORDER", "order-a", "ORDER_RESERVE", 51n);
  return {
    id: "order-a",
    userId: "user-a",
    marketId: "market-a",
    outcome: "YES",
    action: "BUY",
    bookSide: "BUY",
    limitPriceMilli: 50n,
    originalQuantity: 1,
    remainingQuantity: 1,
    filledQuantity: 0,
    canceledQuantity: 0,
    status: "OPEN",
    timeInForce: "GTC",
    postOnly: false,
    selfTradePrevention: "CANCEL_AGGRESSOR",
    reservedCashMilli: 51n,
    reservedFeeMilli: 1n,
    reservedShares: 0,
    acceptedSequence: 1n,
    prioritySequence: 1n,
    expiresAt: null,
    reservation: {
      orderId: "order-a",
      userId: "user-a",
      marketId: "market-a",
      reservedPrincipalMilli: 50n,
      reservedFeeMilli: 1n,
      reservedYesQuantity: 0,
      reservedNoQuantity: 0,
      cashAccount: cash,
    },
    ...overrides,
  };
}

function market(overrides: Partial<LegacyMigrationMarket> = {}): LegacyMigrationMarket {
  return {
    id: "market-a",
    slug: "market-a",
    executionBackend: "DATABASE",
    status: "OPEN",
    resolution: null,
    pricingModel: "ORDER_BOOK",
    acceptingOrders: true,
    closesAt: new Date("2030-01-01T00:00:00.000Z"),
    resolvesAt: new Date("2030-01-02T00:00:00.000Z"),
    payoutMilli: 100n,
    feeBps: 25,
    yesShares: 10,
    noShares: 10,
    version: 3,
    bookSequence: 5n,
    commandSequence: 4n,
    tradeSequence: 2n,
    collateralAccount: ledger("collateral-a", "MARKET", "market-a", "COLLATERAL", 1_000n),
    positions: [position()],
    orders: [order()],
    orderCommandStatuses: ["COMPLETED"],
    chainCommandStatuses: [],
    pendingJournalCount: 0,
    pendingResolutionProposalCount: 0,
    settlementRunStatus: null,
    positionSettlementCount: 0,
    ...overrides,
  };
}

function fixture(overrides: Partial<LegacyMigrationAuditInput> = {}): LegacyMigrationAuditInput {
  return {
    markets: [market()],
    userWallets: [ledger("wallet-a", "USER", "user-a", "AVAILABLE", 500n)],
    ...overrides,
  };
}

describe("legacy DATABASE market migration snapshot", () => {
  it("builds a versioned, canonical ledger-backed snapshot without personal credentials", () => {
    const snapshot = buildLegacyMigrationSnapshot(fixture());

    expect(snapshot).toMatchObject({
      digestAlgorithm: "SHA-256",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      payload: {
        schema: "goosey.legacy-solana-migration-snapshot",
        version: 1,
        source: { executionBackend: "DATABASE", marketCount: 1, userCount: 1 },
        users: [{ userId: "user-a", availableCashMilli: "500" }],
        markets: [{
          marketId: "market-a",
          totals: { collateralMilli: "1000", yesShares: "10", noShares: "10", participantCount: 1, liveOrderCount: 1 },
          participants: [{ userId: "user-a", realizedPnlMilli: "-25" }],
          liveOrders: [{ orderId: "order-a", reservation: { principalMilli: "50", feeMilli: "1" } }],
        }],
      },
    });
    const serialized = canonicalLegacyMigrationSnapshotJson(snapshot.payload);
    expect(serialized).not.toMatch(/email|password|secret|credential|encrypted/i);
    expect(JSON.parse(serialized)).toEqual(snapshot.payload);
  });

  it("is deterministic across source row ordering and changes digest when an amount changes", () => {
    const secondMarket = market({
      id: "market-b",
      slug: "market-b",
      collateralAccount: ledger("collateral-b", "MARKET", "market-b", "COLLATERAL", 0n),
      pricingModel: "LMSR",
      yesShares: 0,
      noShares: 0,
      positions: [],
      orders: [],
    });
    const first = buildLegacyMigrationSnapshot({ ...fixture(), markets: [secondMarket, market()] });
    const second = buildLegacyMigrationSnapshot({ ...fixture(), markets: [market(), secondMarket] });
    expect(first).toEqual(second);

    const changed = buildLegacyMigrationSnapshot({ ...fixture(), userWallets: [ledger("wallet-a", "USER", "user-a", "AVAILABLE", 501n)] });
    expect(changed.digest).not.toBe(buildLegacyMigrationSnapshot(fixture()).digest);
  });

  it.each([
    ["executionBackend", market({ executionBackend: "SOLANA" }), "INELIGIBLE_MARKET"],
    ["resolved", market({ status: "RESOLVED", resolution: "YES" }), "INELIGIBLE_MARKET"],
    ["order command", market({ orderCommandStatuses: ["PROCESSING"] }), "PENDING_ORDER_COMMAND"],
    ["chain command", market({ chainCommandStatuses: ["SUBMITTED"] }), "PENDING_CHAIN_COMMAND"],
    ["journal", market({ pendingJournalCount: 1 }), "PENDING_JOURNAL"],
    ["proposal", market({ pendingResolutionProposalCount: 1 }), "AMBIGUOUS_SETTLEMENT"],
    ["settlement run", market({ settlementRunStatus: "READY" }), "AMBIGUOUS_SETTLEMENT"],
    ["partial settlement", market({ positionSettlementCount: 1 }), "AMBIGUOUS_SETTLEMENT"],
  ])("rejects ambiguous or ineligible %s state", (_label, source, code) => {
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), markets: [source] })).toThrow(expect.objectContaining({ code }));
  });

  it("rejects cached balances that are not proven by posted ledger entries", () => {
    const mismatched = { ...ledger("wallet-a", "USER", "user-a", "AVAILABLE", 500n), postings: [{ amountMilli: 499n, journalStatus: "POSTED" }] };
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), userWallets: [mismatched] })).toThrow(expect.objectContaining({ code: "LEDGER_BALANCE_MISMATCH" }));

    const pending = { ...ledger("wallet-a", "USER", "user-a", "AVAILABLE", 500n), postings: [{ amountMilli: 500n, journalStatus: "PENDING" }] };
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), userWallets: [pending] })).toThrow(expect.objectContaining({ code: "AMBIGUOUS_JOURNAL" }));
  });

  it("rejects reservation and position projection drift", () => {
    const badReservation = order({ reservedCashMilli: 52n });
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), markets: [market({ orders: [badReservation] })] })).toThrow(/reservation caches/i);

    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), markets: [market({ yesShares: 11 })] })).toThrow(expect.objectContaining({ code: "POSITION_TOTAL_MISMATCH" }));
  });

  it("enforces the 256-seat chain capacity", () => {
    const positions = Array.from({ length: 257 }, (_, index) => position({
      userId: `user-${index.toString().padStart(3, "0")}`,
      yesShares: 0,
      noShares: 0,
      netCostMilli: 0n,
      yesCostBasisMilli: 0n,
      noCostBasisMilli: 0n,
      realizedPnlMilli: 0n,
    }));
    const userWallets = positions.map((row, index) => ledger(`wallet-${index}`, "USER", row.userId, "AVAILABLE", 0n));
    expect(() => buildLegacyMigrationSnapshot({
      markets: [market({ pricingModel: "LMSR", yesShares: 0, noShares: 0, positions, orders: [], collateralAccount: ledger("collateral-a", "MARKET", "market-a", "COLLATERAL", 0n) })],
      userWallets,
    })).toThrow(expect.objectContaining({ code: "SEAT_CAPACITY_EXCEEDED" }));
  });

  it("enforces the 1024-live-order chain capacity", () => {
    const orders = Array.from({ length: 1_025 }, (_, index) => {
      const id = `order-${index.toString().padStart(4, "0")}`;
      return order({
        id,
        action: "SELL",
        reservedCashMilli: 0n,
        reservedFeeMilli: 0n,
        reservedShares: 1,
        acceptedSequence: BigInt(index + 1),
        prioritySequence: BigInt(index + 1),
        reservation: { orderId: id, userId: "user-a", marketId: "market-a", reservedPrincipalMilli: 0n, reservedFeeMilli: 0n, reservedYesQuantity: 1, reservedNoQuantity: 0, cashAccount: null },
      });
    });
    expect(() => buildLegacyMigrationSnapshot({
      markets: [market({ pricingModel: "LMSR", yesShares: 1_025, noShares: 0, positions: [position({ yesShares: 1_025, noShares: 0, reservedYesShares: 1_025 })], orders, collateralAccount: ledger("collateral-a", "MARKET", "market-a", "COLLATERAL", 0n) })],
      userWallets: [ledger("wallet-a", "USER", "user-a", "AVAILABLE", 0n)],
    })).toThrow(expect.objectContaining({ code: "ORDER_CAPACITY_EXCEEDED" }));
  });

  it("rejects every chain-bound amount outside u64", () => {
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), userWallets: [ledger("wallet-a", "USER", "user-a", "AVAILABLE", SOLANA_U64_MAX + 1n)] })).toThrow(expect.objectContaining({ code: "U64_OUT_OF_RANGE" }));
    expect(() => buildLegacyMigrationSnapshot({ ...fixture(), markets: [market({ payoutMilli: -1n })] })).toThrow(expect.objectContaining({ code: "U64_OUT_OF_RANGE" }));
  });
});
