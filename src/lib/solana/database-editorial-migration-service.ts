import { createHash } from "node:crypto";

import { type Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { deriveGooseyMarketAddresses } from "@/lib/solana/escrow-client";
import { managedMarketProvisioningEnvelopeSchema } from "@/lib/solana/managed-market-provisioning-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

export const EDITORIAL_MIGRATION_AUDIT_ACTION = "SOLANA_EDITORIAL_MIGRATION_ACCEPTED";
export const EDITORIAL_MIGRATION_EXECUTE_CONFIRMATION = "ACCEPT_SOLANA_EDITORIAL_MIGRATION";
export const EDITORIAL_MIGRATION_PRODUCTION_CONFIRMATION = "MIGRATE_PRODUCTION_DATABASE_MARKET_EDITORIAL_DEFINITIONS";
export type EditorialMigrationEnvironment = "local" | "development" | "staging" | "production";

const marketSelect = {
  id: true,
  slug: true,
  status: true,
  resolution: true,
  resolvedAt: true,
  executionBackend: true,
  pricingModel: true,
  acceptingOrders: true,
  payoutMilli: true,
  feeBps: true,
  closesAt: true,
  resolvesAt: true,
  yesShares: true,
  noShares: true,
  volumeMilli: true,
  traderCount: true,
  bookSequence: true,
  commandSequence: true,
  tradeSequence: true,
  version: true,
  collateralAccountId: true,
  collateralAccount: {
    select: {
      id: true,
      ownerType: true,
      ownerId: true,
      purpose: true,
      balanceMilli: true,
      allowsNegative: true,
      status: true,
      _count: { select: { postings: true, orderReservations: true } },
    },
  },
  solanaBinding: true,
  settlementRun: { select: { id: true } },
  _count: {
    select: {
      positions: true,
      trades: true,
      priceHistory: true,
      quotes: true,
      settlements: true,
      resolutionProposals: true,
      orders: true,
      orderFills: true,
      orderEvents: true,
      orderCommands: true,
      orderReservations: true,
    },
  },
} as const satisfies Prisma.MarketSelect;

type MigrationMarket = Prisma.MarketGetPayload<{ select: typeof marketSelect }>;
type Tx = Prisma.TransactionClient;

export type EditorialMigrationSelector = Readonly<{
  marketIds?: readonly string[];
  slugs?: readonly string[];
  allDatabaseDrafts?: boolean;
}>;

export type EditorialMigrationAssessment = Readonly<{
  marketId: string;
  slug: string;
  state: "eligible" | "blocked" | "accepted";
  blockers: readonly string[];
  commandId: string | null;
}>;

export class EditorialMigrationBlockedError extends Error {
  constructor(readonly assessment: EditorialMigrationAssessment) {
    super(`Market ${assessment.marketId} cannot be migrated: ${assessment.blockers.join("; ")}`);
    this.name = "EditorialMigrationBlockedError";
  }
}

type RelatedState = Readonly<{
  marketJournalCount: number;
  marketChainCommands: readonly Readonly<{
    id: string;
    cluster: string;
    genesisHash: string;
    programAddress: string;
    operation: string;
    idempotencyKey: string;
    requestJson: string;
  }>[];
  migrationAuditCount: number;
}>;

type RuntimeDependencies = Readonly<{
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  targetEnvironment: EditorialMigrationEnvironment;
  executeConfirmation?: string;
  productionConfirmation?: string;
}>;

function authorizedRuntime(dependencies: RuntimeDependencies, write: boolean) {
  const env = dependencies.env ?? process.env;
  if (env.GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT !== dependencies.targetEnvironment) {
    throw new Error("Migration target environment does not match explicit runtime configuration");
  }
  const processIsProduction = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (processIsProduction && dependencies.targetEnvironment !== "production") {
    throw new Error("Production runtime cannot be labeled as a non-production migration target");
  }
  if (write && dependencies.executeConfirmation !== EDITORIAL_MIGRATION_EXECUTE_CONFIRMATION) {
    throw new Error("Editorial migration write confirmation is missing");
  }
  if (write && dependencies.targetEnvironment === "production"
    && dependencies.productionConfirmation !== EDITORIAL_MIGRATION_PRODUCTION_CONFIRMATION) {
    throw new Error("Editorial migration production confirmation is missing");
  }
  return resolveSolanaRuntime(env);
}

function chainMarketIdFor(marketId: string): bigint {
  return createHash("sha256").update("goosey:chain-market-id:v1\0").update(marketId).digest().readBigUInt64LE(0);
}

async function relatedState(tx: Tx, market: MigrationMarket): Promise<RelatedState> {
  const [marketJournalCount, marketChainCommands, migrationAuditCount] = await Promise.all([
    tx.journalEntry.count({ where: { referenceType: "MARKET", referenceId: market.id } }),
    tx.chainCommand.findMany({
      where: { scope: "MARKET", scopeId: market.id },
      select: {
        id: true,
        cluster: true,
        genesisHash: true,
        programAddress: true,
        operation: true,
        idempotencyKey: true,
        requestJson: true,
      },
    }),
    tx.auditLog.count({
      where: { action: EDITORIAL_MIGRATION_AUDIT_ACTION, entityType: "MARKET", entityId: market.id },
    }),
  ]);
  return { marketJournalCount, marketChainCommands, migrationAuditCount };
}

function replayCommandId(
  market: MigrationMarket,
  related: RelatedState,
  runtime: ReturnType<typeof resolveSolanaRuntime>,
): string | null {
  if (market.executionBackend !== "SOLANA" || market.status !== "DRAFT" || market.acceptingOrders
    || market.pricingModel !== "ORDER_BOOK" || market.resolution !== null || market.resolvedAt !== null
    || market.collateralAccountId !== null || !market.solanaBinding || related.migrationAuditCount !== 1
    || related.marketChainCommands.length !== 1) return null;
  const command = related.marketChainCommands[0];
  if (command.operation !== "PROVISION_MARKET" || command.idempotencyKey !== "managed-market:v1"
    || command.cluster !== runtime.cluster || command.genesisHash !== runtime.genesisHash
    || command.programAddress !== runtime.programAddress
    || market.solanaBinding.cluster !== runtime.cluster
    || market.solanaBinding.genesisHash !== runtime.genesisHash
    || market.solanaBinding.programAddress !== runtime.programAddress) return null;
  let request: unknown;
  try { request = JSON.parse(command.requestJson); }
  catch { return null; }
  const envelope = managedMarketProvisioningEnvelopeSchema.safeParse(request);
  if (!envelope.success || envelope.data.request.marketId !== market.id
    || envelope.data.request.marketSlug !== market.slug
    || envelope.data.request.chainMarketId !== chainMarketIdFor(market.id).toString()
    || envelope.data.request.chainMarketId !== market.solanaBinding.chainMarketId
    || envelope.data.request.marketAddress !== market.solanaBinding.marketAddress
    || envelope.data.request.payoutMilli !== market.payoutMilli.toString()
    || envelope.data.request.feeBps !== market.feeBps
    || envelope.data.request.closesAt !== market.closesAt.toISOString()
    || envelope.data.request.resolvesAt !== market.resolvesAt.toISOString()
    || envelope.data.request.requestedVisibility !== "DRAFT") return null;
  return command.id;
}

function assess(
  market: MigrationMarket,
  related: RelatedState,
  runtime: ReturnType<typeof resolveSolanaRuntime>,
): EditorialMigrationAssessment {
  const commandId = replayCommandId(market, related, runtime);
  if (commandId) return { marketId: market.id, slug: market.slug, state: "accepted", blockers: [], commandId };

  const blockers: string[] = [];
  if (market.executionBackend !== "DATABASE") blockers.push("market is not an unmigrated DATABASE market");
  if (market.status !== "DRAFT") blockers.push("market is not hidden in DRAFT status");
  if (market.acceptingOrders) blockers.push("market is accepting orders");
  if (market.pricingModel !== "ORDER_BOOK") blockers.push("pricing model is not ORDER_BOOK");
  if (market.resolution !== null || market.resolvedAt !== null) blockers.push("market has resolution state");
  if (market.solanaBinding) blockers.push("market already has a Solana binding");
  if (!market.collateralAccount || market.collateralAccountId !== market.collateralAccount.id
    || market.collateralAccount.ownerType !== "MARKET" || market.collateralAccount.ownerId !== market.id
    || market.collateralAccount.purpose !== "COLLATERAL" || market.collateralAccount.allowsNegative
    || market.collateralAccount.status !== "ACTIVE") {
    blockers.push("market collateral account is missing or noncanonical");
  } else {
    if (market.collateralAccount.balanceMilli !== 0n) blockers.push("collateral account has a nonzero balance");
    if (market.collateralAccount._count.postings !== 0) blockers.push("collateral account has ledger postings");
    if (market.collateralAccount._count.orderReservations !== 0) blockers.push("collateral account has order reservations");
  }
  if (market.yesShares !== 0 || market.noShares !== 0 || market.volumeMilli !== 0n || market.traderCount !== 0) {
    blockers.push("market financial totals are nonzero");
  }
  if (market.bookSequence !== 0n || market.commandSequence !== 0n || market.tradeSequence !== 0n) {
    blockers.push("market sequencing shows prior activity");
  }
  const relationLabels: Array<[keyof MigrationMarket["_count"], string]> = [
    ["positions", "positions"], ["trades", "trades"], ["priceHistory", "price history"],
    ["quotes", "trade quotes"], ["settlements", "position settlements"],
    ["resolutionProposals", "resolution proposals"], ["orders", "orders"], ["orderFills", "order fills"],
    ["orderEvents", "order events"], ["orderCommands", "order commands"], ["orderReservations", "order reservations"],
  ];
  for (const [key, label] of relationLabels) if (market._count[key] !== 0) blockers.push(`market has ${label}`);
  if (market.settlementRun) blockers.push("market has a settlement run");
  if (related.marketJournalCount !== 0) blockers.push("market has journal entries");
  if (related.marketChainCommands.length !== 0) blockers.push("market has prior chain commands");
  if (related.migrationAuditCount !== 0) blockers.push("market has an inconsistent migration audit trail");
  if (market.closesAt.getMilliseconds() !== 0 || market.resolvesAt.getMilliseconds() !== 0) {
    blockers.push("market timestamps are not aligned to whole seconds");
  }
  if (market.payoutMilli <= 0n || market.payoutMilli > 999_999_999_999_999_999n) blockers.push("payout is outside provisioning bounds");
  if (!Number.isInteger(market.feeBps) || market.feeBps < 0 || market.feeBps > 1_000) blockers.push("fee is outside provisioning bounds");
  return { marketId: market.id, slug: market.slug, state: blockers.length ? "blocked" : "eligible", blockers, commandId: null };
}

function selectorWhere(selector: EditorialMigrationSelector): Prisma.MarketWhereInput {
  const marketIds = [...new Set(selector.marketIds ?? [])];
  const slugs = [...new Set(selector.slugs ?? [])];
  if (selector.allDatabaseDrafts) {
    if (marketIds.length || slugs.length) throw new Error("allDatabaseDrafts cannot be combined with explicit markets");
    return { executionBackend: "DATABASE", status: "DRAFT" };
  }
  if (!marketIds.length && !slugs.length) throw new Error("At least one market id or slug is required");
  return { OR: [
    ...(marketIds.length ? [{ id: { in: marketIds } }] : []),
    ...(slugs.length ? [{ slug: { in: slugs } }] : []),
  ] };
}

async function selectedMarkets(tx: Tx, selector: EditorialMigrationSelector): Promise<MigrationMarket[]> {
  const markets = await tx.market.findMany({ where: selectorWhere(selector), select: marketSelect, orderBy: { id: "asc" } });
  const expected = new Set([...(selector.marketIds ?? []), ...(selector.slugs ?? [])]);
  if (!selector.allDatabaseDrafts && markets.length !== expected.size) {
    throw new Error("One or more explicitly selected markets were not found");
  }
  return markets;
}

export async function inspectDatabaseEditorialMigrations(
  selector: EditorialMigrationSelector,
  dependencies: RuntimeDependencies,
): Promise<readonly EditorialMigrationAssessment[]> {
  const runtime = authorizedRuntime(dependencies, false);
  return runSerializableTransaction(dependencies.database ?? db, async tx => {
    const markets = await selectedMarkets(tx, selector);
    return Promise.all(markets.map(async market => assess(market, await relatedState(tx, market), runtime)));
  });
}

export async function acceptDatabaseEditorialMigration(
  marketId: string,
  actorUserId: string,
  dependencies: RuntimeDependencies,
): Promise<EditorialMigrationAssessment> {
  const runtime = authorizedRuntime(dependencies, true);
  return runSerializableTransaction(dependencies.database ?? db, async tx => {
    const actor = await tx.user.findUnique({ where: { id: actorUserId }, select: { role: true, status: true } });
    if (actor?.role !== "ADMIN" || actor.status !== "ACTIVE") throw new Error("An active administrator is required");
    const market = await tx.market.findUnique({ where: { id: marketId }, select: marketSelect });
    if (!market) throw new Error(`Market ${marketId} was not found`);
    const related = await relatedState(tx, market);
    const assessment = assess(market, related, runtime);
    if (assessment.state === "accepted") return assessment;
    if (assessment.state === "blocked") throw new EditorialMigrationBlockedError(assessment);

    const chainMarketId = chainMarketIdFor(market.id);
    const addresses = await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId: chainMarketId });
    const request = {
      provisioningVersion: 1 as const,
      marketId: market.id,
      marketSlug: market.slug,
      chainMarketId: chainMarketId.toString(),
      marketAddress: addresses.market,
      payoutMilli: market.payoutMilli.toString(),
      feeBps: market.feeBps,
      closesAt: market.closesAt.toISOString(),
      resolvesAt: market.resolvesAt.toISOString(),
      requestedVisibility: "DRAFT" as const,
    };
    managedMarketProvisioningEnvelopeSchema.parse({ version: 1, operation: "PROVISION_MARKET", request });
    const identity = acceptChainCommand({ runtime, scope: "MARKET", scopeId: market.id, actorId: actorUserId,
      operation: "PROVISION_MARKET", idempotencyKey: "managed-market:v1", request });
    const changed = await tx.market.updateMany({
      where: {
        id: market.id,
        version: market.version,
        executionBackend: "DATABASE",
        status: "DRAFT",
        acceptingOrders: false,
        pricingModel: "ORDER_BOOK",
        collateralAccountId: market.collateralAccountId,
      },
      data: { executionBackend: "SOLANA", collateralAccountId: null, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new Error("Market changed during editorial migration; inspect and retry");
    await tx.solanaMarketBinding.create({ data: {
      marketId: market.id,
      cluster: runtime.cluster,
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      marketAddress: addresses.market,
      chainMarketId: chainMarketId.toString(),
    } });
    const command = await tx.chainCommand.create({ data: identity });
    await tx.auditLog.create({ data: {
      actorUserId,
      action: EDITORIAL_MIGRATION_AUDIT_ACTION,
      entityType: "MARKET",
      entityId: market.id,
      metadata: jsonStringify({
        sourceExecutionBackend: "DATABASE",
        sourceMarketVersion: market.version,
        detachedEmptyCollateralAccountId: market.collateralAccountId,
        destinationExecutionBackend: "SOLANA",
        destinationVisibility: "DRAFT",
        financialStateCopied: false,
        chainMarketId,
        marketAddress: addresses.market,
        commandId: command.id,
      }),
    } });
    return { marketId: market.id, slug: market.slug, state: "accepted", blockers: [], commandId: command.id };
  });
}
