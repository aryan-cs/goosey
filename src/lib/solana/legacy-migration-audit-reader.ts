import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import {
  buildLegacyMigrationSnapshot,
  type LegacyLedgerAccount,
  type LegacyMigrationAuditInput,
  type LegacyMigrationSnapshot,
} from "@/lib/solana/legacy-migration-audit";

const ELIGIBLE_MARKET_STATUSES = ["OPEN", "PAUSED", "CLOSED"] as const;
const LIVE_ORDER_STATUSES = new Set(["OPEN", "PARTIALLY_FILLED"]);

type PostingRecord = Readonly<{
  amountMilli: bigint;
  journalEntry: Readonly<{ status: string }>;
}>;

type AccountRecord = Readonly<{
  id: string;
  ownerType: string;
  ownerId: string | null;
  purpose: string;
  balanceMilli: bigint;
  status: string;
  postings: readonly PostingRecord[];
}>;

function account(record: AccountRecord | null): LegacyLedgerAccount | null {
  if (!record) return null;
  return {
    id: record.id,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    purpose: record.purpose,
    balanceMilli: record.balanceMilli,
    status: record.status,
    postings: record.postings.map((posting) => ({
      amountMilli: posting.amountMilli,
      journalStatus: posting.journalEntry.status,
    })),
  };
}

const ledgerInclude = {
  postings: {
    include: { journalEntry: { select: { status: true } } },
    orderBy: { id: "asc" as const },
  },
} as const;

/**
 * Reads the legacy financial state at one serializable database snapshot.
 * Every operation is a find/read; this function never updates the database or
 * submits a Solana transaction.
 */
export async function readLegacyMigrationAuditInput(client: TransactionRunner): Promise<LegacyMigrationAuditInput> {
  return runSerializableTransaction(client, async (tx) => {
    const markets = await tx.market.findMany({
      where: {
        executionBackend: "DATABASE",
        status: { in: [...ELIGIBLE_MARKET_STATUSES] },
        resolution: null,
      },
      orderBy: { id: "asc" },
      include: {
        collateralAccount: { include: ledgerInclude },
        positions: { orderBy: { userId: "asc" } },
        orders: {
          orderBy: [{ prioritySequence: "asc" }, { id: "asc" }],
          include: {
            reservation: {
              include: { cashAccount: { include: ledgerInclude } },
            },
          },
        },
        orderCommands: { select: { status: true }, orderBy: { id: "asc" } },
        resolutionProposals: { select: { status: true }, orderBy: { id: "asc" } },
        settlementRun: { select: { status: true } },
        settlements: { select: { id: true }, orderBy: { id: "asc" } },
      },
    });

    const marketIds = markets.map((market) => market.id);
    const participantIds = [...new Set(markets.flatMap((market) => [
      ...market.positions.map((position) => position.userId),
      ...market.orders
        .filter((order) => LIVE_ORDER_STATUSES.has(order.status) && order.remainingQuantity > 0)
        .map((order) => order.userId),
    ]))].sort();

    const [walletRecords, chainCommands, pendingJournals] = await Promise.all([
      participantIds.length === 0
        ? Promise.resolve([])
        : tx.ledgerAccount.findMany({
            where: { ownerType: "USER", ownerId: { in: participantIds }, purpose: "AVAILABLE" },
            orderBy: { ownerId: "asc" },
            include: ledgerInclude,
          }),
      marketIds.length === 0
        ? Promise.resolve([])
        : tx.chainCommand.findMany({
            where: { scope: "MARKET", scopeId: { in: marketIds } },
            select: { scopeId: true, status: true },
            orderBy: [{ scopeId: "asc" }, { id: "asc" }],
          }),
      marketIds.length === 0
        ? Promise.resolve([])
        : tx.journalEntry.findMany({
            where: { referenceId: { in: marketIds }, status: { not: "POSTED" } },
            select: { referenceId: true },
            orderBy: { id: "asc" },
          }),
    ]);

    return {
      userWallets: walletRecords.map((wallet) => account(wallet)!),
      markets: markets.map((market) => ({
        id: market.id,
        slug: market.slug,
        executionBackend: market.executionBackend,
        status: market.status,
        resolution: market.resolution,
        pricingModel: market.pricingModel,
        acceptingOrders: market.acceptingOrders,
        closesAt: market.closesAt,
        resolvesAt: market.resolvesAt,
        payoutMilli: market.payoutMilli,
        feeBps: market.feeBps,
        yesShares: market.yesShares,
        noShares: market.noShares,
        version: market.version,
        bookSequence: market.bookSequence,
        commandSequence: market.commandSequence,
        tradeSequence: market.tradeSequence,
        collateralAccount: account(market.collateralAccount),
        positions: market.positions.map((position) => ({
          userId: position.userId,
          marketId: position.marketId,
          yesShares: position.yesShares,
          noShares: position.noShares,
          reservedYesShares: position.reservedYesShares,
          reservedNoShares: position.reservedNoShares,
          netCostMilli: position.netCostMilli,
          yesCostBasisMilli: position.yesCostBasisMilli,
          noCostBasisMilli: position.noCostBasisMilli,
          realizedPnlMilli: position.realizedPnlMilli,
        })),
        orders: market.orders.map((order) => ({
          id: order.id,
          userId: order.userId,
          marketId: order.marketId,
          outcome: order.outcome,
          action: order.action,
          bookSide: order.bookSide,
          limitPriceMilli: order.limitPriceMilli,
          originalQuantity: order.originalQuantity,
          remainingQuantity: order.remainingQuantity,
          filledQuantity: order.filledQuantity,
          canceledQuantity: order.canceledQuantity,
          status: order.status,
          timeInForce: order.timeInForce,
          postOnly: order.postOnly,
          selfTradePrevention: order.selfTradePrevention,
          reservedCashMilli: order.reservedCashMilli,
          reservedFeeMilli: order.reservedFeeMilli,
          reservedShares: order.reservedShares,
          acceptedSequence: order.acceptedSequence,
          prioritySequence: order.prioritySequence,
          expiresAt: order.expiresAt,
          reservation: order.reservation ? {
            orderId: order.reservation.orderId,
            userId: order.reservation.userId,
            marketId: order.reservation.marketId,
            reservedPrincipalMilli: order.reservation.reservedPrincipalMilli,
            reservedFeeMilli: order.reservation.reservedFeeMilli,
            reservedYesQuantity: order.reservation.reservedYesQuantity,
            reservedNoQuantity: order.reservation.reservedNoQuantity,
            cashAccount: account(order.reservation.cashAccount),
          } : null,
        })),
        orderCommandStatuses: market.orderCommands.map((command) => command.status),
        chainCommandStatuses: chainCommands.filter((command) => command.scopeId === market.id).map((command) => command.status),
        pendingJournalCount: pendingJournals.filter((journal) => journal.referenceId === market.id).length,
        pendingResolutionProposalCount: market.resolutionProposals.filter((proposal) => proposal.status === "PENDING").length,
        settlementRunStatus: market.settlementRun?.status ?? null,
        positionSettlementCount: market.settlements.length,
      })),
    };
  });
}

export async function buildLegacyMigrationAuditSnapshot(client: TransactionRunner): Promise<LegacyMigrationSnapshot> {
  return buildLegacyMigrationSnapshot(await readLegacyMigrationAuditInput(client));
}
