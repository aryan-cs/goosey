import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tx: undefined as unknown }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/serializable-transaction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/serializable-transaction")>("@/lib/serializable-transaction");
  return { ...actual, runSerializableTransaction: vi.fn((_db, operation) => operation(mocks.tx)) };
});

import {
  acceptDatabaseEditorialMigration,
  EditorialMigrationBlockedError,
  inspectDatabaseEditorialMigrations,
} from "./database-editorial-migration-service";

const env = {
  GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT: "local",
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};

function fixture(overrides: Record<string, unknown> = {}) {
  const market = {
    id: "market_editorial_1", slug: "editorial-market", status: "DRAFT", resolution: null, resolvedAt: null,
    executionBackend: "DATABASE", pricingModel: "ORDER_BOOK", acceptingOrders: false,
    payoutMilli: 100_000n, feeBps: 25, closesAt: new Date("2030-01-01T00:00:00.000Z"),
    resolvesAt: new Date("2030-01-02T00:00:00.000Z"), yesShares: 0, noShares: 0, volumeMilli: 0n,
    traderCount: 0, bookSequence: 0n, commandSequence: 0n, tradeSequence: 0n, version: 3,
    collateralAccountId: "ledger_empty_1", collateralAccount: { id: "ledger_empty_1", ownerType: "MARKET",
      ownerId: "market_editorial_1", purpose: "COLLATERAL", balanceMilli: 0n, allowsNegative: false,
      status: "ACTIVE", _count: { postings: 0, orderReservations: 0 } },
    solanaBinding: null, settlementRun: null,
    _count: { positions: 0, trades: 0, priceHistory: 0, quotes: 0, settlements: 0, resolutionProposals: 0,
      orders: 0, orderFills: 0, orderEvents: 0, orderCommands: 0, orderReservations: 0 },
    ...overrides,
  };
  const state = { commands: [] as Record<string, unknown>[], binding: null as Record<string, unknown> | null, audits: 0 };
  const tx = {
    user: { findUnique: vi.fn(async () => ({ role: "ADMIN", status: "ACTIVE" })) },
    market: {
      findMany: vi.fn(async () => [market]),
      findUnique: vi.fn(async () => ({ ...market, solanaBinding: state.binding })),
      updateMany: vi.fn(async () => { market.executionBackend = "SOLANA"; market.collateralAccountId = null as never;
        market.version += 1; return { count: 1 }; }),
    },
    journalEntry: { count: vi.fn(async () => 0) },
    chainCommand: {
      findMany: vi.fn(async () => state.commands),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: "command_1", ...data }; state.commands.push(row); return row;
      }),
    },
    auditLog: {
      count: vi.fn(async () => state.audits),
      create: vi.fn(async () => { state.audits += 1; return {}; }),
    },
    solanaMarketBinding: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (state.binding = data)) },
  };
  return { market, state, tx };
}

describe("DATABASE editorial migration acceptance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts an empty order-book draft through the standard durable provisioning command path", async () => {
    const f = fixture(); mocks.tx = f.tx;
    const result = await acceptDatabaseEditorialMigration(f.market.id, "admin_1", { database: {} as never, env,
      targetEnvironment: "local", executeConfirmation: "ACCEPT_SOLANA_EDITORIAL_MIGRATION" });
    expect(result).toMatchObject({ state: "accepted", commandId: "command_1" });
    expect(f.tx.market.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { executionBackend: "SOLANA", collateralAccountId: null, version: { increment: 1 } },
    }));
    expect(f.tx.chainCommand.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      scope: "MARKET", scopeId: f.market.id, operation: "PROVISION_MARKET", idempotencyKey: "managed-market:v1",
    }) });
    const request = JSON.parse(String(f.state.commands[0].requestJson));
    expect(request).toMatchObject({ operation: "PROVISION_MARKET", request: { requestedVisibility: "DRAFT" } });
    expect(f.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      action: "SOLANA_EDITORIAL_MIGRATION_ACCEPTED",
      metadata: expect.stringContaining('"financialStateCopied":false'),
    }) });
  });

  it("fails closed when any financial evidence exists", async () => {
    const f = fixture({ volumeMilli: 1n, _count: { positions: 0, trades: 1, priceHistory: 0, quotes: 0,
      settlements: 0, resolutionProposals: 0, orders: 0, orderFills: 0, orderEvents: 0, orderCommands: 0,
      orderReservations: 0 } });
    mocks.tx = f.tx;
    await expect(acceptDatabaseEditorialMigration(f.market.id, "admin_1", { database: {} as never, env,
      targetEnvironment: "local", executeConfirmation: "ACCEPT_SOLANA_EDITORIAL_MIGRATION" }))
      .rejects.toBeInstanceOf(EditorialMigrationBlockedError);
    expect(f.tx.market.updateMany).not.toHaveBeenCalled();
    expect(f.tx.chainCommand.create).not.toHaveBeenCalled();
  });

  it("dry-run reports LMSR and collateralized definitions as blocked without writing", async () => {
    const f = fixture({ pricingModel: "LMSR", collateralAccount: { id: "ledger_empty_1", ownerType: "MARKET",
      ownerId: "market_editorial_1", purpose: "COLLATERAL", balanceMilli: 500n, allowsNegative: false,
      status: "ACTIVE", _count: { postings: 2, orderReservations: 0 } } });
    mocks.tx = f.tx;
    const [assessment] = await inspectDatabaseEditorialMigrations({ slugs: [f.market.slug] }, { database: {} as never, env,
      targetEnvironment: "local" });
    expect(assessment.state).toBe("blocked");
    expect(assessment.blockers).toEqual(expect.arrayContaining([
      "pricing model is not ORDER_BOOK", "collateral account has a nonzero balance", "collateral account has ledger postings",
    ]));
    expect(f.tx.market.updateMany).not.toHaveBeenCalled();
  });

  it("is resumable: an accepted migration replays without a second mutation", async () => {
    const f = fixture(); mocks.tx = f.tx;
    const dependencies = { database: {} as never, env, targetEnvironment: "local" as const,
      executeConfirmation: "ACCEPT_SOLANA_EDITORIAL_MIGRATION" };
    const first = await acceptDatabaseEditorialMigration(f.market.id, "admin_1", dependencies);
    const replay = await acceptDatabaseEditorialMigration(f.market.id, "admin_1", dependencies);
    expect(replay).toEqual(first);
    expect(f.tx.market.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.chainCommand.create).toHaveBeenCalledOnce();
  });

  it("refuses direct service writes without explicit runtime and execute authorization", async () => {
    const f = fixture(); mocks.tx = f.tx;
    await expect(acceptDatabaseEditorialMigration(f.market.id, "admin_1", { database: {} as never, env,
      targetEnvironment: "local" })).rejects.toThrow("write confirmation is missing");
    await expect(inspectDatabaseEditorialMigrations({ marketIds: [f.market.id] }, { database: {} as never,
      env: { ...env, GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT: "staging" }, targetEnvironment: "local" }))
      .rejects.toThrow("does not match explicit runtime configuration");
    expect(f.tx.market.findUnique).not.toHaveBeenCalled();
  });
});
