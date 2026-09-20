import type { Prisma } from "@prisma/client";
import { createSolanaRpc } from "@solana/kit";

import { db } from "@/lib/db";
import { DATABASE_MARKET_FILTER } from "@/lib/market-backend";
import { loadMarketMarks, type LoadedMarketMark } from "@/lib/market-marks";
import { ApiError } from "@/lib/market-service";
import { selectMarketMark } from "@/lib/order-book-pricing";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import { marketSummary } from "@/lib/view-models";
import { projectSolanaCatalogItem, solanaCatalogSelect } from "@/lib/solana/catalog-read";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { readPublicSolanaIndexerStatus, SOLANA_INDEXER_STALE_AFTER_MS } from "@/lib/solana/indexer-health";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";
import { readSolanaTradeTape } from "@/lib/solana/trade-tape";

const U64_MAX = (1n << 64n) - 1n;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

const databaseInclude = {
  priceHistory: { orderBy: { createdAt: "desc" as const }, take: 30 },
  orderFills: {
    orderBy: { tradeSequence: "desc" as const },
    take: 30,
    select: { canonicalYesPriceMilli: true, createdAt: true },
  },
} as const satisfies Prisma.MarketInclude;

type DatabaseMarketRow = Prisma.MarketGetPayload<{ include: typeof databaseInclude }>;
type SolanaCatalogRow = Prisma.MarketGetPayload<{ select: typeof solanaCatalogSelect }>;
type SolanaCatalogItem = Awaited<ReturnType<typeof projectSolanaCatalogItem>>;

export type UnifiedMarketEditorial = Readonly<{
  id: string;
  slug: string;
  title: string;
  shortTitle: string;
  description: string;
  rules: string;
  resolutionSource: string;
  category: string;
  featured: boolean;
  color: string;
  icon: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type UnifiedDatabaseMarket = Readonly<{
  executionBackend: "DATABASE";
  href: string;
  editorial: UnifiedMarketEditorial;
  /** The legacy row is deliberately confined to this discriminated branch. */
  financial: Readonly<{
    source: "database";
    market: DatabaseMarketRow;
    mark: LoadedMarketMark;
    summary: ReturnType<typeof marketSummary>;
  }>;
}>;

export type UnifiedSolanaMarketFinancial = Readonly<{
  source: "solana-finalized";
  finalizedSlot: bigint;
  coverageRevision: number;
  coverageUpdatedAt: Date;
  marketAddress: string;
  chainMarketId: bigint;
  payoutMilli: bigint;
  feeBps: number;
  closesAt: Date;
  resolvesAt: Date;
  status: "OPEN" | "CLOSED" | "RESOLVING" | "RESOLVED";
  acceptingOrders: boolean;
  resolution: "YES" | "NO" | "VOID" | null;
  probabilityYesBps: number | null;
  probabilitySource: "MID" | "SETTLEMENT" | "NONE";
  bids: readonly Readonly<{ priceMilli: bigint; quantity: bigint }>[];
  asks: readonly Readonly<{ priceMilli: bigint; quantity: bigint }>[];
  traderCount: number;
  recentTrades: readonly Readonly<{
    signature: string;
    slot: bigint;
    logIndex: number;
    quantity: bigint;
    yesPriceMilli: bigint;
  }>[];
  recentTradeWindowComplete: boolean;
}>;

export type UnifiedSolanaMarket = Readonly<{
  executionBackend: "SOLANA";
  href: string;
  editorial: UnifiedMarketEditorial;
  /** No SQL financial field is admitted to this object. */
  financial: UnifiedSolanaMarketFinancial;
}>;

export type UnifiedMarket = UnifiedDatabaseMarket | UnifiedSolanaMarket;

type PublicMarketStatus = "OPEN" | "PAUSED" | "CLOSED" | "RESOLVED" | "VOID";

export type UnifiedMarketListQuery = Readonly<{
  status?: PublicMarketStatus;
  statuses?: readonly PublicMarketStatus[];
  category?: string;
  q?: string;
  sort?: "featured" | "newest" | "closing";
  limit?: number;
}>;

type ChainProjectionLoader = (
  runtime: SolanaRuntime,
  item: SolanaCatalogItem,
  now: Date,
  client: TransactionRunner,
  signal?: AbortSignal,
) => Promise<UnifiedSolanaMarketFinancial>;

export type UnifiedMarketRepositoryOptions = Readonly<{
  client?: TransactionRunner;
  runtime?: SolanaRuntime;
  now?: () => Date;
  loadSolanaProjection?: ChainProjectionLoader;
}>;

function parseChainMarketId(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error("Invalid stored Solana market ID");
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new Error("Stored Solana market ID exceeds u64");
  return parsed;
}

function exactDateFromSeconds(value: bigint, field: string): Date {
  const milliseconds = value * 1_000n;
  if (value < 0n || milliseconds > 8_640_000_000_000_000n) throw new Error(`Invalid finalized ${field}`);
  return new Date(Number(milliseconds));
}

export function assertFinalizedSolanaProjectionCoverage(
  status: Awaited<ReturnType<typeof readPublicSolanaIndexerStatus>>,
  now: Date,
  staleAfterMs = SOLANA_INDEXER_STALE_AFTER_MS,
) {
  const updatedAt = status.coverage.updatedAt === null ? null : new Date(status.coverage.updatedAt);
  if (status.worker.state !== "running" || status.coverage.status !== "bounded_complete"
    || status.coverage.revision === null || !updatedAt || !Number.isFinite(updatedAt.getTime())
    || updatedAt.getTime() > now.getTime()
    || now.getTime() - updatedAt.getTime() >= staleAfterMs) {
    throw new ApiError(503, "SOLANA_PROJECTION_UNAVAILABLE",
      "Finalized Solana market projections are unavailable, incomplete, or stale.");
  }
  return { revision: status.coverage.revision, updatedAt };
}

/** Public display reads may use a finalized RPC snapshot while the immutable
 * event tape is explicitly incomplete. This never authorizes a mutation and
 * never treats partial history as complete. */
export function resolveSolanaDisplayCoverage(
  status: Awaited<ReturnType<typeof readPublicSolanaIndexerStatus>>,
  now: Date,
) {
  try {
    return { ...assertFinalizedSolanaProjectionCoverage(status, now), complete: true as const };
  } catch (error) {
    const updatedAt = status.coverage.updatedAt === null ? null : new Date(status.coverage.updatedAt);
    if ((status.coverage.status !== "partial" && status.coverage.status !== "bounded_complete")
      || status.coverage.revision === null || !updatedAt || !Number.isFinite(updatedAt.getTime())
      || updatedAt.getTime() > now.getTime()) throw error;
    return { revision: status.coverage.revision, updatedAt, complete: false as const };
  }
}

function resolutionPrice(outcome: number | null, payoutMilli: bigint): bigint | null {
  if (outcome === null) return null;
  if (outcome === 0) return payoutMilli;
  if (outcome === 1) return 0n;
  if (outcome === 2) return payoutMilli / 2n;
  throw new Error("Invalid finalized resolution outcome");
}

function chainStatus(phase: number, closesAt: Date, now: Date) {
  if (phase === 0) return closesAt > now ? "OPEN" as const : "CLOSED" as const;
  if (phase === 1) return "CLOSED" as const;
  if (phase === 2) return "RESOLVING" as const;
  if (phase === 3 || phase === 4) return "RESOLVED" as const;
  throw new Error("Invalid finalized resolution phase");
}

/**
 * Assemble one SOLANA financial view from finalized RPC state plus an immutable
 * finalized event projection. SQL contributes only the already-validated
 * editorial catalog item and immutable binding passed by the caller.
 */
export async function loadFinalizedSolanaMarketProjection(
  runtime: SolanaRuntime,
  item: SolanaCatalogItem,
  now: Date,
  client: TransactionRunner,
  suppliedSignal?: AbortSignal,
): Promise<UnifiedSolanaMarketFinancial> {
  const signal = suppliedSignal
    ? AbortSignal.any([suppliedSignal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const health = await runSerializableTransaction(client,
    tx => readPublicSolanaIndexerStatus(runtime, { client: tx, now }));
  const coverage = resolveSolanaDisplayCoverage(health, now);
  const marketId = parseChainMarketId(item.chain.marketId);
  const tape = await readSolanaTradeTape(runtime, marketId, { limit: 50 }, client);
  if ((coverage.complete && tape.coverage.status !== "bounded_complete")
    || (!coverage.complete && tape.coverage.status !== "partial" && tape.coverage.status !== "bounded_complete")
    || tape.coverage.revision !== coverage.revision
    || !(tape.coverage.updatedAt instanceof Date)
    || tape.coverage.updatedAt.getTime() !== coverage.updatedAt.getTime()) {
    throw new ApiError(503, "SOLANA_PROJECTION_UNAVAILABLE",
      "Finalized Solana market projections changed or became incomplete during the read.");
  }

  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: runtime.programAddress }, {
    rpc,
    signal,
    includeMarketTerms: true,
  });
  if (snapshot.market !== item.chain.marketAddress || snapshot.marketState.marketId !== marketId
    || !snapshot.orderBook || !snapshot.resolution || !snapshot.marketTerms
    || !snapshot.marketTerms.sealed || snapshot.marketTerms.acceptanceBits !== 3) {
    throw new Error("Finalized Solana snapshot does not match the catalog binding");
  }
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during the unified market read");
  }
  signal.throwIfAborted();

  const payoutMilli = snapshot.marketState.payoutMilli;
  if (tape.items.some(trade => trade.slot > snapshot.finalizedSlot || trade.yesPrice > payoutMilli)) {
    throw new Error("Finalized trade projection is inconsistent with the market snapshot");
  }
  const settled = resolutionPrice(snapshot.resolution.outcome, payoutMilli);
  const mark = selectMarketMark({
    bids: snapshot.orderBook.bids.map(order => ({ priceMilli: order.canonicalYesPrice, quantity: order.remaining })),
    asks: snapshot.orderBook.asks.map(order => ({ priceMilli: order.canonicalYesPrice, quantity: order.remaining })),
    payoutMilli,
    nowMs: BigInt(now.getTime()),
    settlementPriceMilli: settled,
  });
  if (mark.source === "LAST") throw new Error("A last-trade mark requires a finalized execution timestamp");
  const closesAt = exactDateFromSeconds(snapshot.marketState.closesAt, "close time");
  const resolvesAt = exactDateFromSeconds(snapshot.marketState.resolvesAt, "resolution time");
  const status = chainStatus(snapshot.resolution.phase, closesAt, now);
  const outcome = snapshot.resolution.outcome;
  return {
    source: "solana-finalized",
    finalizedSlot: snapshot.finalizedSlot,
    coverageRevision: coverage.revision,
    coverageUpdatedAt: coverage.updatedAt,
    marketAddress: snapshot.market,
    chainMarketId: marketId,
    payoutMilli,
    feeBps: snapshot.marketState.feeBps,
    closesAt,
    resolvesAt,
    status,
    acceptingOrders: status === "OPEN" && snapshot.resolution.phase === 0,
    resolution: outcome === null ? null : (["YES", "NO", "VOID"] as const)[outcome] ?? null,
    probabilityYesBps: mark.displayProbabilityBps === null ? null : Number(mark.displayProbabilityBps),
    probabilitySource: mark.source,
    bids: snapshot.orderBook.bids.map(order => ({ priceMilli: order.canonicalYesPrice, quantity: order.remaining })),
    asks: snapshot.orderBook.asks.map(order => ({ priceMilli: order.canonicalYesPrice, quantity: order.remaining })),
    traderCount: snapshot.orderBook.seatReserves.filter(seat => seat.everTraded).length,
    recentTrades: tape.items.map(trade => ({ signature: trade.signature, slot: trade.slot,
      logIndex: trade.logIndex, quantity: trade.quantity, yesPriceMilli: trade.yesPrice })),
    recentTradeWindowComplete: coverage.complete && tape.nextCursor === null,
  };
}

function editorialFromDatabase(market: DatabaseMarketRow): UnifiedMarketEditorial {
  return { id: market.id, slug: market.slug, title: market.title, shortTitle: market.shortTitle,
    description: market.description, rules: market.rules, resolutionSource: market.resolutionSource,
    category: market.category, featured: market.featured, color: market.color, icon: market.icon,
    createdAt: market.createdAt, updatedAt: market.updatedAt };
}

function editorialFromSolana(row: SolanaCatalogRow, item: SolanaCatalogItem): UnifiedMarketEditorial {
  return { id: row.id, slug: item.slug, title: item.title, shortTitle: item.shortTitle,
    description: item.description, rules: item.rules, resolutionSource: item.resolutionSource,
    category: item.category, featured: item.featured, color: item.color, icon: item.icon,
    createdAt: item.createdAt, updatedAt: item.updatedAt };
}

function parseQuery(input: UnifiedMarketListQuery) {
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ApiError(400, "INVALID_QUERY", "Market limit is invalid.");
  const q = input.q?.trim();
  const category = input.category?.trim();
  if (q !== undefined && (q.length < 1 || q.length > 100)) throw new ApiError(400, "INVALID_QUERY", "Market search is invalid.");
  if (category !== undefined && (category.length < 1 || category.length > 60)) throw new ApiError(400, "INVALID_QUERY", "Market category is invalid.");
  if (input.status !== undefined && input.statuses !== undefined) throw new ApiError(400, "INVALID_QUERY", "Choose one market status filter.");
  const statuses = input.statuses === undefined ? [input.status ?? "OPEN"] : [...new Set(input.statuses)];
  if (statuses.length === 0) throw new ApiError(400, "INVALID_QUERY", "At least one market status is required.");
  return { statuses, sort: input.sort ?? "featured", limit, q, category };
}

function matchesRequestedStatus(market: UnifiedSolanaMarket, statuses: readonly PublicMarketStatus[]) {
  if (statuses.includes(market.financial.status === "RESOLVING" ? "CLOSED" : market.financial.status)) return true;
  return statuses.includes("VOID") && market.financial.status === "RESOLVED" && market.financial.resolution === "VOID";
}

function commonWhere(query: ReturnType<typeof parseQuery>): Prisma.MarketWhereInput {
  return {
    ...(query.category ? { category: query.category } : {}),
    ...(query.q ? { OR: [{ title: { contains: query.q } }, { shortTitle: { contains: query.q } },
      { description: { contains: query.q } }] } : {}),
  };
}

function sortMarkets(items: UnifiedMarket[], sort: ReturnType<typeof parseQuery>["sort"]) {
  return items.sort((left, right) => {
    if (sort === "featured" && left.editorial.featured !== right.editorial.featured) return left.editorial.featured ? -1 : 1;
    const leftDate = sort === "closing"
      ? (left.executionBackend === "SOLANA" ? left.financial.closesAt : left.financial.market.closesAt)
      : left.editorial.createdAt;
    const rightDate = sort === "closing"
      ? (right.executionBackend === "SOLANA" ? right.financial.closesAt : right.financial.market.closesAt)
      : right.editorial.createdAt;
    const delta = leftDate.getTime() - rightDate.getTime();
    if (delta !== 0) return sort === "closing" ? delta : -delta;
    return left.editorial.id.localeCompare(right.editorial.id);
  });
}

function databaseView(market: DatabaseMarketRow, mark: LoadedMarketMark): UnifiedDatabaseMarket {
  return { executionBackend: "DATABASE", href: `/markets/${market.slug}`, editorial: editorialFromDatabase(market),
    financial: { source: "database", market, mark,
      summary: marketSummary({ ...market, priceHistory: [...market.priceHistory].reverse() }, mark.probabilityYesBps) } };
}

export function createUnifiedMarketReadRepository(options: UnifiedMarketRepositoryOptions = {}) {
  const client = options.client ?? db;
  const now = options.now ?? (() => new Date());
  const loadProjection = options.loadSolanaProjection ?? loadFinalizedSolanaMarketProjection;
  const runtime = () => options.runtime ?? resolveSolanaRuntime();

  async function solanaView(row: SolanaCatalogRow, at: Date): Promise<UnifiedSolanaMarket> {
    const deployment = runtime();
    const item = await projectSolanaCatalogItem(row, deployment);
    const financial = await loadProjection(deployment, item, at, client);
    return { executionBackend: "SOLANA", href: `/markets/${item.slug}`,
      editorial: editorialFromSolana(row, item), financial };
  }

  return {
    async findBySlug(slug: string): Promise<UnifiedMarket | null> {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 160) {
        throw new ApiError(400, "INVALID_MARKET_SLUG", "Market slug is invalid.");
      }
      const at = now();
      const selected = await runSerializableTransaction(client, async tx => {
        const database = await tx.market.findUnique({ where: { slug, AND: [DATABASE_MARKET_FILTER] }, include: databaseInclude });
        if (database) {
          if (database.status === "DRAFT") return null;
          const mark = (await loadMarketMarks(tx, [database], at)).get(database.id);
          if (!mark) throw new Error("Database market mark is unavailable");
          return { kind: "DATABASE" as const, market: database, mark };
        }
        const solana = await tx.market.findUnique({ where: { slug }, select: solanaCatalogSelect });
        if (!solana || solana.executionBackend !== "SOLANA" || solana.collateralAccountId !== null
          || solana.status !== "OPEN" || solana.acceptingOrders || !solana.solanaBinding) return null;
        return { kind: "SOLANA" as const, market: solana };
      });
      if (!selected) return null;
      return selected.kind === "DATABASE" ? databaseView(selected.market, selected.mark) : solanaView(selected.market, at);
    },

    async list(input: UnifiedMarketListQuery = {}): Promise<readonly UnifiedMarket[]> {
      const query = parseQuery(input), at = now(), shared = commonWhere(query);
      const rows = await runSerializableTransaction(client, async tx => {
        const [databaseRows, solanaRows] = await Promise.all([
          tx.market.findMany({ where: { ...shared, ...DATABASE_MARKET_FILTER,
            status: query.statuses.length === 1 ? query.statuses[0] : { in: query.statuses } }, include: databaseInclude,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: query.limit + 1 }),
          tx.market.findMany({ where: { ...shared, executionBackend: "SOLANA", collateralAccountId: null,
            status: "OPEN", acceptingOrders: false, solanaBinding: { isNot: null } }, select: solanaCatalogSelect,
            orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: query.limit + 1 }),
        ]);
        const marks = await loadMarketMarks(tx, databaseRows, at);
        return { databaseRows: databaseRows.map(market => {
          const mark = marks.get(market.id);
          if (!mark) throw new Error("Database market mark is unavailable");
          return databaseView(market, mark);
        }), solanaRows };
      });
      const solana = await Promise.all(rows.solanaRows.map(row => solanaView(row, at)));
      const visibleSolana = solana.filter(market => matchesRequestedStatus(market, query.statuses));
      return sortMarkets([...rows.databaseRows, ...visibleSolana], query.sort).slice(0, query.limit);
    },
  } as const;
}

export const unifiedMarketReadRepository = createUnifiedMarketReadRepository();
