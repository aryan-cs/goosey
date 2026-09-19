import type { Prisma } from "@prisma/client";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deriveGooseyMarketAddresses } from "@/lib/solana/escrow-client";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import type { TransactionRunner } from "@/lib/serializable-transaction";
import {
  assertFinalizedSolanaProjectionCoverage,
  createUnifiedMarketReadRepository,
  type UnifiedSolanaMarketFinancial,
} from "./unified-market-repository";

const now = new Date("2026-09-19T18:00:00.000Z");
const runtime: SolanaRuntime = {
  cluster: "localnet",
  rpcUrl: "http://127.0.0.1:20999/",
  genesisHash: "AjRRqwWwwxKWRZrjiGbAFWzXWgqXLEm9V9HxfMdPF1qV",
  programAddress: address("CgEGshY4XEgKLBb7xRbbUWN5A4QvLJZ9cnTKrw4rQeWm"),
};

function databaseMarket(overrides: Record<string, unknown> = {}) {
  return {
    id: "database-market",
    executionBackend: "DATABASE",
    slug: "database-market",
    title: "Will the database market resolve YES?",
    shortTitle: "Database market",
    description: "A legacy database-backed prediction market used during migration.",
    rules: "Resolves YES when the stated condition occurs.",
    resolutionSource: "https://example.com/source",
    category: "Hackathon",
    status: "OPEN",
    resolution: null,
    featured: false,
    color: "gold",
    icon: "sparkles",
    closesAt: new Date("2026-09-20T18:00:00.000Z"),
    resolvesAt: new Date("2026-09-21T18:00:00.000Z"),
    resolvedAt: null,
    yesShares: 0,
    noShares: 0,
    liquidityParameter: 40,
    payoutMilli: 100_000n,
    feeBps: 0,
    volumeMilli: 0n,
    traderCount: 0,
    commentCount: 0,
    version: 0,
    pricingModel: "LMSR",
    bookSequence: 0n,
    commandSequence: 0n,
    tradeSequence: 0n,
    engineVersion: 1,
    acceptingOrders: true,
    createdById: "admin",
    eventId: null,
    collateralAccountId: "database-collateral",
    createdAt: new Date("2026-09-18T12:00:00.000Z"),
    updatedAt: new Date("2026-09-19T12:00:00.000Z"),
    priceHistory: [],
    orderFills: [],
    ...overrides,
  };
}

async function solanaMarket(overrides: Record<string, unknown> = {}) {
  const canonical = await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId: 7n });
  return {
    id: "solana-market",
    executionBackend: "SOLANA",
    collateralAccountId: null,
    acceptingOrders: false,
    slug: "solana-market",
    title: "Will the Solana market resolve YES?",
    shortTitle: "Solana market",
    description: "A market whose financial state is finalized by the Goosey Solana program.",
    rules: "YES: condition occurs. NO: condition does not occur. VOID: source unavailable.",
    resolutionSource: "https://example.com/chain-source",
    category: "Hackathon",
    status: "OPEN",
    featured: true,
    color: "black",
    icon: "goose",
    // Deliberately conflicting SQL financial metadata. It must not enter the result.
    closesAt: new Date("2035-01-01T00:00:00.000Z"),
    resolvesAt: new Date("2035-01-02T00:00:00.000Z"),
    payoutMilli: 999_999n,
    feeBps: 9_999,
    createdAt: new Date("2026-09-19T10:00:00.000Z"),
    updatedAt: new Date("2026-09-19T11:00:00.000Z"),
    solanaBinding: {
      cluster: runtime.cluster,
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      marketAddress: canonical.market,
      chainMarketId: "7",
    },
    ...overrides,
  };
}

function finalizedProjection(overrides: Partial<UnifiedSolanaMarketFinancial> = {}): UnifiedSolanaMarketFinancial {
  return {
    source: "solana-finalized",
    finalizedSlot: 500n,
    coverageRevision: 3,
    coverageUpdatedAt: new Date("2026-09-19T17:59:30.000Z"),
    marketAddress: "Au1xe1zALe12gebNgwK4XbLyMqFtEFK861UZNDZSsCYN",
    chainMarketId: 7n,
    payoutMilli: 100_000n,
    feeBps: 25,
    closesAt: new Date("2026-09-20T18:00:00.000Z"),
    resolvesAt: new Date("2026-09-21T18:00:00.000Z"),
    status: "OPEN",
    acceptingOrders: true,
    resolution: null,
    probabilityYesBps: 5_250,
    probabilitySource: "MID",
    bids: [{ priceMilli: 50_000n, quantity: 2n }],
    asks: [{ priceMilli: 55_000n, quantity: 3n }],
    traderCount: 2,
    recentTrades: [],
    recentTradeWindowComplete: true,
    ...overrides,
  };
}

function runner(tx: Record<string, unknown>): TransactionRunner {
  return {
    $transaction: vi.fn(async (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
      operation(tx as Prisma.TransactionClient)),
  } as unknown as TransactionRunner;
}

describe("unified market read repository", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps DATABASE markets on the legacy read path without touching Solana", async () => {
    const row = databaseMarket();
    const findUnique = vi.fn(async (args: { include?: unknown }) => args.include ? row : null);
    const loadSolanaProjection = vi.fn();
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findUnique, findMany: vi.fn(), }, marketOrder: { groupBy: vi.fn() } }),
      runtime,
      now: () => now,
      loadSolanaProjection,
    });

    const result = await repository.findBySlug(row.slug);

    expect(result).toMatchObject({ executionBackend: "DATABASE", href: "/markets/database-market",
      financial: { source: "database" } });
    expect(result?.executionBackend === "DATABASE" && result.financial.market.collateralAccountId)
      .toBe("database-collateral");
    expect(loadSolanaProjection).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it("uses only finalized projection finances for a SOLANA binding", async () => {
    const row = await solanaMarket();
    const projection = finalizedProjection();
    const findUnique = vi.fn(async (args: { include?: unknown }) => args.include ? null : row);
    const loadSolanaProjection = vi.fn().mockResolvedValue(projection);
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findUnique, findMany: vi.fn() } }), runtime, now: () => now, loadSolanaProjection,
    });

    const result = await repository.findBySlug(row.slug);

    expect(result).toEqual({ executionBackend: "SOLANA", href: "/markets/solana-market",
      editorial: { id: row.id, slug: row.slug, title: row.title, shortTitle: row.shortTitle,
        description: row.description, rules: row.rules, resolutionSource: row.resolutionSource,
        category: row.category, featured: row.featured, color: row.color, icon: row.icon,
        createdAt: row.createdAt, updatedAt: row.updatedAt }, financial: projection });
    expect(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("999999");
    expect(loadSolanaProjection).toHaveBeenCalledOnce();
  });

  it("loads DATABASE and SOLANA rows through separate scoped queries", async () => {
    const database = databaseMarket();
    const solana = await solanaMarket();
    const findMany = vi.fn(async (args: { where: { executionBackend: string }; select?: unknown; include?: unknown }) => {
      if (args.where.executionBackend === "DATABASE") {
        expect(args.include).toBeDefined();
        expect(args.select).toBeUndefined();
        return [database];
      }
      expect(args.where.executionBackend).toBe("SOLANA");
      expect(args.select).toBeDefined();
      expect(args.include).toBeUndefined();
      return [solana];
    });
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findMany }, marketOrder: { groupBy: vi.fn() } }), runtime, now: () => now,
      loadSolanaProjection: vi.fn().mockResolvedValue(finalizedProjection()),
    });

    const result = await repository.list({ status: "OPEN", limit: 10 });

    expect(result.map(item => item.executionBackend)).toEqual(["SOLANA", "DATABASE"]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it("fails the entire unified list instead of serving stale Solana data", async () => {
    const solana = await solanaMarket();
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findMany: vi.fn(async (args: { where: { executionBackend: string } }) =>
        args.where.executionBackend === "SOLANA" ? [solana] : []) }, marketOrder: { groupBy: vi.fn() } }),
      runtime,
      now: () => now,
      loadSolanaProjection: vi.fn().mockRejectedValue(new Error("stale projection")),
    });

    await expect(repository.list()).rejects.toThrow("stale projection");
  });

  it("filters a catalog OPEN market when finalized chain state is no longer open", async () => {
    const solana = await solanaMarket();
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findMany: vi.fn(async (args: { where: { executionBackend: string } }) =>
        args.where.executionBackend === "SOLANA" ? [solana] : []) }, marketOrder: { groupBy: vi.fn() } }),
      runtime,
      now: () => now,
      loadSolanaProjection: vi.fn().mockResolvedValue(finalizedProjection({ status: "CLOSED", acceptingOrders: false })),
    });

    await expect(repository.list({ status: "OPEN" })).resolves.toEqual([]);
  });

  it("uses finalized chain status for historical filters instead of catalog visibility", async () => {
    const solana = await solanaMarket();
    const findMany = vi.fn(async (args: { where: { executionBackend: string; status: string } }) => {
      if (args.where.executionBackend !== "SOLANA") return [];
      expect(args.where.status).toBe("OPEN");
      return [solana];
    });
    const repository = createUnifiedMarketReadRepository({
      client: runner({ market: { findMany }, marketOrder: { groupBy: vi.fn() } }),
      runtime,
      now: () => now,
      loadSolanaProjection: vi.fn().mockResolvedValue(finalizedProjection({ status: "CLOSED", acceptingOrders: false })),
    });

    const result = await repository.list({ status: "CLOSED" });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ executionBackend: "SOLANA", financial: { status: "CLOSED" } });
  });
});

describe("finalized projection coverage gate", () => {
  const healthy = {
    worker: { state: "running", updatedAt: now.toISOString(), cycleCount: "2", successCount: "2",
      failureCount: "0", consecutiveFailures: 0 },
    coverage: { status: "bounded_complete", revision: 4,
      updatedAt: new Date(now.getTime() - 1_000).toISOString(), fullHistory: false },
  } as const;

  it("accepts only a fresh running bounded-complete projection", () => {
    expect(assertFinalizedSolanaProjectionCoverage(healthy as never, now)).toEqual({
      revision: 4,
      updatedAt: new Date(now.getTime() - 1_000),
    });
  });

  it.each([
    { worker: { ...healthy.worker, state: "stale" } },
    { coverage: { ...healthy.coverage, status: "partial" } },
    { coverage: { ...healthy.coverage, updatedAt: new Date(now.getTime() - 180_000).toISOString() } },
    { coverage: { ...healthy.coverage, updatedAt: new Date(now.getTime() + 1).toISOString() } },
  ])("fails closed for unhealthy coverage %#", patch => {
    const value = { ...healthy, ...patch };
    expect(() => assertFinalizedSolanaProjectionCoverage(value as never, now)).toThrow(
      expect.objectContaining({ code: "SOLANA_PROJECTION_UNAVAILABLE" }),
    );
  });
});
