import { createHash } from "node:crypto";

import {
  ACTIVE_ORDER_STATUSES,
  assertActiveReservationConsistency,
  assertOrderBookMarketAccounting,
  assertOrderQuantityConservation,
  assertPositionReservationConsistency,
} from "@/lib/invariants";

export const LEGACY_MIGRATION_SNAPSHOT_SCHEMA = "goosey.legacy-solana-migration-snapshot" as const;
export const LEGACY_MIGRATION_SNAPSHOT_VERSION = 1 as const;
export const SOLANA_MARKET_SEAT_CAP = 256;
export const SOLANA_LIVE_ORDER_CAP = 1_024;
export const SOLANA_U64_MAX = (1n << 64n) - 1n;

export class LegacyMigrationAuditError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LegacyMigrationAuditError";
  }
}

export type LegacyLedgerAccount = Readonly<{
  id: string;
  ownerType: string;
  ownerId: string | null;
  purpose: string;
  balanceMilli: bigint;
  status: string;
  postings: readonly Readonly<{ amountMilli: bigint; journalStatus: string }>[];
}>;

export type LegacyMigrationReservation = Readonly<{
  orderId: string;
  userId: string;
  marketId: string;
  reservedPrincipalMilli: bigint;
  reservedFeeMilli: bigint;
  reservedYesQuantity: number;
  reservedNoQuantity: number;
  cashAccount: LegacyLedgerAccount | null;
}>;

export type LegacyMigrationOrder = Readonly<{
  id: string;
  userId: string;
  marketId: string;
  outcome: string;
  action: string;
  bookSide: string;
  limitPriceMilli: bigint;
  originalQuantity: number;
  remainingQuantity: number;
  filledQuantity: number;
  canceledQuantity: number;
  status: string;
  timeInForce: string;
  postOnly: boolean;
  selfTradePrevention: string;
  reservedCashMilli: bigint;
  reservedFeeMilli: bigint;
  reservedShares: number;
  acceptedSequence: bigint;
  prioritySequence: bigint;
  expiresAt: Date | null;
  reservation: LegacyMigrationReservation | null;
}>;

export type LegacyMigrationPosition = Readonly<{
  userId: string;
  marketId: string;
  yesShares: number;
  noShares: number;
  reservedYesShares: number;
  reservedNoShares: number;
  netCostMilli: bigint;
  yesCostBasisMilli: bigint;
  noCostBasisMilli: bigint;
  realizedPnlMilli: bigint;
}>;

export type LegacyMigrationMarket = Readonly<{
  id: string;
  slug: string;
  executionBackend: string;
  status: string;
  resolution: string | null;
  pricingModel: string;
  acceptingOrders: boolean;
  closesAt: Date;
  resolvesAt: Date;
  payoutMilli: bigint;
  feeBps: number;
  yesShares: number;
  noShares: number;
  version: number;
  bookSequence: bigint;
  commandSequence: bigint;
  tradeSequence: bigint;
  collateralAccount: LegacyLedgerAccount | null;
  positions: readonly LegacyMigrationPosition[];
  orders: readonly LegacyMigrationOrder[];
  orderCommandStatuses: readonly string[];
  chainCommandStatuses: readonly string[];
  pendingJournalCount: number;
  pendingResolutionProposalCount: number;
  settlementRunStatus: string | null;
  positionSettlementCount: number;
}>;

export type LegacyMigrationAuditInput = Readonly<{
  markets: readonly LegacyMigrationMarket[];
  userWallets: readonly LegacyLedgerAccount[];
}>;

type Decimal = string;

export type LegacyMigrationSnapshotPayload = Readonly<{
  schema: typeof LEGACY_MIGRATION_SNAPSHOT_SCHEMA;
  version: typeof LEGACY_MIGRATION_SNAPSHOT_VERSION;
  source: Readonly<{
    executionBackend: "DATABASE";
    eligibleStatuses: readonly ["CLOSED", "OPEN", "PAUSED"];
    marketCount: number;
    userCount: number;
  }>;
  users: readonly Readonly<{ userId: string; availableCashMilli: Decimal }>[];
  markets: readonly Readonly<{
    marketId: string;
    slug: string;
    status: "CLOSED" | "OPEN" | "PAUSED";
    pricingModel: string;
    acceptingOrders: boolean;
    closesAt: string;
    resolvesAt: string;
    payoutMilli: Decimal;
    feeBps: number;
    version: number;
    bookSequence: Decimal;
    commandSequence: Decimal;
    tradeSequence: Decimal;
    totals: Readonly<{
      collateralMilli: Decimal;
      yesShares: Decimal;
      noShares: Decimal;
      participantCount: number;
      liveOrderCount: number;
    }>;
    participants: readonly Readonly<{
      userId: string;
      yesShares: Decimal;
      noShares: Decimal;
      reservedYesShares: Decimal;
      reservedNoShares: Decimal;
      netCostMilli: Decimal;
      yesCostBasisMilli: Decimal;
      noCostBasisMilli: Decimal;
      realizedPnlMilli: Decimal;
    }>[];
    liveOrders: readonly Readonly<{
      orderId: string;
      userId: string;
      outcome: "NO" | "YES";
      action: "BUY" | "SELL";
      bookSide: "BUY" | "SELL";
      limitPriceMilli: Decimal;
      remainingQuantity: Decimal;
      timeInForce: string;
      postOnly: boolean;
      selfTradePrevention: string;
      acceptedSequence: Decimal;
      prioritySequence: Decimal;
      expiresAt: string | null;
      reservation: Readonly<{
        principalMilli: Decimal;
        feeMilli: Decimal;
        yesQuantity: Decimal;
        noQuantity: Decimal;
      }>;
    }>[];
  }>[];
}>;

export type LegacyMigrationSnapshot = Readonly<{
  digestAlgorithm: "SHA-256";
  digest: string;
  payload: LegacyMigrationSnapshotPayload;
}>;

function fail(code: string, message: string): never {
  throw new LegacyMigrationAuditError(code, message);
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("NON_CANONICAL_NUMBER", "Snapshot numbers must be safe integers.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) fail("NON_CANONICAL_VALUE", "Snapshot contains a non-JSON value.");
  if (seen.has(value)) fail("CYCLIC_VALUE", "Snapshot contains a cyclic value.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail("NON_PLAIN_OBJECT", "Snapshot contains a non-plain object.");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalLegacyMigrationSnapshotJson(payload: LegacyMigrationSnapshotPayload): string {
  return canonicalJson(payload);
}

function u64(value: bigint | number, label: string): bigint {
  const parsed = typeof value === "number"
    ? Number.isSafeInteger(value) ? BigInt(value) : fail("U64_OUT_OF_RANGE", `${label} is not a safe integer.`)
    : value;
  if (parsed < 0n || parsed > SOLANA_U64_MAX) fail("U64_OUT_OF_RANGE", `${label} does not fit in a Solana u64.`);
  return parsed;
}

function signedDecimal(value: bigint, label: string): Decimal {
  if (value < -SOLANA_U64_MAX || value > SOLANA_U64_MAX) {
    fail("SIGNED_AMOUNT_OUT_OF_RANGE", `${label} exceeds the migration snapshot's signed amount bounds.`);
  }
  return value.toString();
}

function ledgerBalance(account: LegacyLedgerAccount, label: string): bigint {
  if (account.status !== "ACTIVE") fail("LEDGER_ACCOUNT_INACTIVE", `${label} is not active.`);
  if (account.postings.some((posting) => posting.journalStatus !== "POSTED")) {
    fail("AMBIGUOUS_JOURNAL", `${label} has a non-posted journal entry.`);
  }
  const posted = account.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
  if (posted !== account.balanceMilli) fail("LEDGER_BALANCE_MISMATCH", `${label} does not match its posted ledger balance.`);
  return u64(posted, label);
}

function uniqueById<T>(rows: readonly T[], id: (row: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = id(row);
    if (seen.has(value)) fail("DUPLICATE_SOURCE_ROW", `${label} contains duplicate ${value}.`);
    seen.add(value);
  }
}

const ELIGIBLE_STATUSES = new Set(["OPEN", "PAUSED", "CLOSED"]);

/**
 * Builds a deterministic, read-only migration artifact. It deliberately retains
 * source IDs only; usernames, email addresses, wallet secrets and credentials
 * are neither accepted nor emitted.
 */
export function buildLegacyMigrationSnapshot(input: LegacyMigrationAuditInput): LegacyMigrationSnapshot {
  uniqueById(input.markets, (market) => market.id, "markets");
  uniqueById(input.userWallets, (wallet) => wallet.ownerId ?? "", "user wallets");

  const participantIds = new Set<string>();
  const markets = [...input.markets].sort((left, right) => left.id.localeCompare(right.id)).map((market) => {
    if (market.executionBackend !== "DATABASE" || !ELIGIBLE_STATUSES.has(market.status) || market.resolution !== null) {
      fail("INELIGIBLE_MARKET", `Market ${market.id} is not an open or unresolved DATABASE market.`);
    }
    if (!Number.isSafeInteger(market.version) || market.version < 0) fail("MARKET_VERSION_INVALID", `Market ${market.id} has an invalid version.`);
    if (!Number.isSafeInteger(market.feeBps) || market.feeBps < 0 || market.feeBps > 10_000) fail("MARKET_FEE_INVALID", `Market ${market.id} has an invalid fee.`);
    if (!market.collateralAccount || market.collateralAccount.ownerType !== "MARKET" || market.collateralAccount.ownerId !== market.id || market.collateralAccount.purpose !== "COLLATERAL") {
      fail("COLLATERAL_ACCOUNT_INVALID", `Market ${market.id} has no canonical collateral account.`);
    }
    if (market.orderCommandStatuses.some((status) => status !== "COMPLETED")) {
      fail("PENDING_ORDER_COMMAND", `Market ${market.id} has an incomplete order command.`);
    }
    if (market.chainCommandStatuses.some((status) => !["PROJECTED", "FAILED_TERMINAL"].includes(status))) {
      fail("PENDING_CHAIN_COMMAND", `Market ${market.id} has an ambiguous chain command.`);
    }
    if (market.pendingJournalCount !== 0) fail("PENDING_JOURNAL", `Market ${market.id} has a pending journal entry.`);
    if (market.pendingResolutionProposalCount !== 0 || market.settlementRunStatus !== null || market.positionSettlementCount !== 0) {
      fail("AMBIGUOUS_SETTLEMENT", `Market ${market.id} has pending or partial settlement state.`);
    }

    uniqueById(market.positions, (position) => position.userId, `market ${market.id} positions`);
    uniqueById(market.orders, (order) => order.id, `market ${market.id} orders`);
    const liveOrders = market.orders.filter((order) => ACTIVE_ORDER_STATUSES.has(order.status) && order.remainingQuantity > 0);
    if (liveOrders.length > SOLANA_LIVE_ORDER_CAP) fail("ORDER_CAPACITY_EXCEEDED", `Market ${market.id} exceeds 1024 live orders.`);

    const reservations = liveOrders.map((order) => {
      if (order.marketId !== market.id) fail("ORDER_MARKET_MISMATCH", `Order ${order.id} belongs to another market.`);
      assertOrderQuantityConservation(order);
      assertActiveReservationConsistency(order, order.reservation);
      const reservation = order.reservation!;
      if (reservation.orderId !== order.id) fail("RESERVATION_ORDER_MISMATCH", `Order ${order.id} has another order's reservation.`);
      const reservedCash = reservation.reservedPrincipalMilli + reservation.reservedFeeMilli;
      if (reservedCash > 0n) {
        if (!reservation.cashAccount) fail("RESERVATION_LEDGER_MISSING", `Order ${order.id} has no reservation ledger account.`);
        if (reservation.cashAccount.ownerType !== "ORDER" || reservation.cashAccount.ownerId !== order.id || reservation.cashAccount.purpose !== "ORDER_RESERVE") {
          fail("RESERVATION_LEDGER_INVALID", `Order ${order.id} has a noncanonical reservation ledger account.`);
        }
        const ledger = ledgerBalance(reservation.cashAccount, `order ${order.id} reservation`);
        if (ledger !== reservedCash) fail("RESERVATION_LEDGER_MISMATCH", `Order ${order.id} reservation does not match its ledger account.`);
      } else if (reservation.cashAccount !== null) {
        const ledger = ledgerBalance(reservation.cashAccount, `order ${order.id} reservation`);
        if (ledger !== 0n) fail("RESERVATION_LEDGER_MISMATCH", `Order ${order.id} has unexpected reservation cash.`);
      }
      participantIds.add(order.userId);
      return reservation;
    });

    for (const order of market.orders) {
      if (!liveOrders.includes(order)) {
        assertOrderQuantityConservation(order);
        assertActiveReservationConsistency(order, order.reservation);
      }
    }

    for (const position of market.positions) {
      if (position.marketId !== market.id) fail("POSITION_MARKET_MISMATCH", `A position belongs to another market than ${market.id}.`);
      assertPositionReservationConsistency(position, reservations);
      participantIds.add(position.userId);
    }
    const marketParticipantIds = new Set([...market.positions.map((position) => position.userId), ...liveOrders.map((order) => order.userId)]);
    if (marketParticipantIds.size > SOLANA_MARKET_SEAT_CAP) fail("SEAT_CAPACITY_EXCEEDED", `Market ${market.id} exceeds 256 participant seats.`);

    const aggregateYes = market.positions.reduce((sum, position) => sum + u64(position.yesShares, "position YES shares"), 0n);
    const aggregateNo = market.positions.reduce((sum, position) => sum + u64(position.noShares, "position NO shares"), 0n);
    if (aggregateYes !== u64(market.yesShares, `market ${market.id} YES shares`) || aggregateNo !== u64(market.noShares, `market ${market.id} NO shares`)) {
      fail("POSITION_TOTAL_MISMATCH", `Market ${market.id} position totals do not match market totals.`);
    }
    const collateral = ledgerBalance(market.collateralAccount, `market ${market.id} collateral`);
    u64(market.payoutMilli, `market ${market.id} payout`);
    u64(market.bookSequence, `market ${market.id} book sequence`);
    u64(market.commandSequence, `market ${market.id} command sequence`);
    u64(market.tradeSequence, `market ${market.id} trade sequence`);
    if (market.pricingModel === "ORDER_BOOK") {
      try {
        assertOrderBookMarketAccounting({ yesShares: market.yesShares, noShares: market.noShares, payoutMilli: market.payoutMilli, collateralMilli: collateral });
      } catch (error) {
        fail("ORDER_BOOK_ACCOUNTING_MISMATCH", error instanceof Error ? error.message : "Order-book accounting is inconsistent.");
      }
    }

    return {
      marketId: market.id,
      slug: market.slug,
      status: market.status as "CLOSED" | "OPEN" | "PAUSED",
      pricingModel: market.pricingModel,
      acceptingOrders: market.acceptingOrders,
      closesAt: market.closesAt.toISOString(),
      resolvesAt: market.resolvesAt.toISOString(),
      payoutMilli: market.payoutMilli.toString(),
      feeBps: market.feeBps,
      version: market.version,
      bookSequence: market.bookSequence.toString(),
      commandSequence: market.commandSequence.toString(),
      tradeSequence: market.tradeSequence.toString(),
      totals: { collateralMilli: collateral.toString(), yesShares: aggregateYes.toString(), noShares: aggregateNo.toString(), participantCount: marketParticipantIds.size, liveOrderCount: liveOrders.length },
      participants: [...market.positions].sort((left, right) => left.userId.localeCompare(right.userId)).map((position) => ({
        userId: position.userId,
        yesShares: u64(position.yesShares, "position YES shares").toString(),
        noShares: u64(position.noShares, "position NO shares").toString(),
        reservedYesShares: u64(position.reservedYesShares, "reserved YES shares").toString(),
        reservedNoShares: u64(position.reservedNoShares, "reserved NO shares").toString(),
        netCostMilli: signedDecimal(position.netCostMilli, "position net cost"),
        yesCostBasisMilli: u64(position.yesCostBasisMilli, "YES cost basis").toString(),
        noCostBasisMilli: u64(position.noCostBasisMilli, "NO cost basis").toString(),
        realizedPnlMilli: signedDecimal(position.realizedPnlMilli, "realized PnL"),
      })),
      liveOrders: [...liveOrders].sort((left, right) => left.prioritySequence < right.prioritySequence ? -1 : left.prioritySequence > right.prioritySequence ? 1 : left.id.localeCompare(right.id)).map((order) => {
        if (!order.reservation) fail("RESERVATION_MISSING", `Order ${order.id} has no reservation.`);
        if (!(["YES", "NO"] as const).includes(order.outcome as "YES" | "NO") || !(["BUY", "SELL"] as const).includes(order.action as "BUY" | "SELL") || !(["BUY", "SELL"] as const).includes(order.bookSide as "BUY" | "SELL")) {
          fail("ORDER_ENUM_INVALID", `Order ${order.id} contains an unsupported side or action.`);
        }
        if (order.limitPriceMilli <= 0n || order.limitPriceMilli >= market.payoutMilli) {
          fail("ORDER_PRICE_INVALID", `Order ${order.id} has an invalid limit price.`);
        }
        return {
          orderId: order.id,
          userId: order.userId,
          outcome: order.outcome as "NO" | "YES",
          action: order.action as "BUY" | "SELL",
          bookSide: order.bookSide as "BUY" | "SELL",
          limitPriceMilli: u64(order.limitPriceMilli, `order ${order.id} price`).toString(),
          remainingQuantity: u64(order.remainingQuantity, `order ${order.id} quantity`).toString(),
          timeInForce: order.timeInForce,
          postOnly: order.postOnly,
          selfTradePrevention: order.selfTradePrevention,
          acceptedSequence: u64(order.acceptedSequence, `order ${order.id} accepted sequence`).toString(),
          prioritySequence: u64(order.prioritySequence, `order ${order.id} priority sequence`).toString(),
          expiresAt: order.expiresAt?.toISOString() ?? null,
          reservation: {
            principalMilli: u64(order.reservation.reservedPrincipalMilli, `order ${order.id} principal`).toString(),
            feeMilli: u64(order.reservation.reservedFeeMilli, `order ${order.id} fee`).toString(),
            yesQuantity: u64(order.reservation.reservedYesQuantity, `order ${order.id} reserved YES`).toString(),
            noQuantity: u64(order.reservation.reservedNoQuantity, `order ${order.id} reserved NO`).toString(),
          },
        };
      }),
    };
  });

  const wallets = new Map<string, LegacyLedgerAccount>();
  for (const wallet of input.userWallets) {
    if (wallet.ownerType !== "USER" || !wallet.ownerId || wallet.purpose !== "AVAILABLE") {
      fail("USER_WALLET_INVALID", `Ledger account ${wallet.id} is not a canonical user wallet.`);
    }
    wallets.set(wallet.ownerId, wallet);
  }
  const users = [...participantIds].sort().map((userId) => {
    const wallet = wallets.get(userId);
    if (!wallet) fail("USER_WALLET_MISSING", `Participant ${userId} has no canonical user wallet.`);
    return { userId, availableCashMilli: ledgerBalance(wallet, `user ${userId} wallet`).toString() };
  });
  if (wallets.size !== users.length) fail("UNEXPECTED_USER_WALLET", "The source contains a wallet for a non-participant.");

  const payload: LegacyMigrationSnapshotPayload = {
    schema: LEGACY_MIGRATION_SNAPSHOT_SCHEMA,
    version: LEGACY_MIGRATION_SNAPSHOT_VERSION,
    source: { executionBackend: "DATABASE", eligibleStatuses: ["CLOSED", "OPEN", "PAUSED"], marketCount: markets.length, userCount: users.length },
    users,
    markets,
  };
  const digest = createHash("sha256").update(canonicalLegacyMigrationSnapshotJson(payload), "utf8").digest("hex");
  return { digestAlgorithm: "SHA-256", digest, payload };
}
