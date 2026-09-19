import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import type { TransactionRunner } from "@/lib/serializable-transaction";
import { buildLegacyMigrationAuditSnapshot, readLegacyMigrationAuditInput } from "./legacy-migration-audit-reader";

function fixture() {
  const market = {
    id: "market-a",
    slug: "market-a",
    executionBackend: "DATABASE",
    status: "CLOSED",
    resolution: null,
    pricingModel: "LMSR",
    acceptingOrders: false,
    closesAt: new Date("2030-01-01T00:00:00.000Z"),
    resolvesAt: new Date("2030-01-02T00:00:00.000Z"),
    payoutMilli: 100n,
    feeBps: 0,
    yesShares: 0,
    noShares: 0,
    version: 1,
    bookSequence: 0n,
    commandSequence: 0n,
    tradeSequence: 0n,
    collateralAccount: {
      id: "collateral-a",
      ownerType: "MARKET",
      ownerId: "market-a",
      purpose: "COLLATERAL",
      balanceMilli: 0n,
      status: "ACTIVE",
      postings: [],
    },
    positions: [],
    orders: [],
    orderCommands: [{ status: "COMPLETED" }],
    resolutionProposals: [],
    settlementRun: null,
    settlements: [],
  };
  const tx = {
    market: { findMany: vi.fn().mockResolvedValue([market]) },
    ledgerAccount: { findMany: vi.fn().mockResolvedValue([]) },
    chainCommand: { findMany: vi.fn().mockResolvedValue([{ scopeId: "market-a", status: "PROJECTED" }]) },
    journalEntry: { findMany: vi.fn().mockResolvedValue([]) },
    marketOrder: { update: vi.fn() },
    marketSettlementRun: { create: vi.fn() },
  };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>, options?: { isolationLevel: Prisma.TransactionIsolationLevel }) => {
    expect(options?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
    return operation(tx);
  });
  return { market, tx, transaction, client: { $transaction: transaction } as unknown as TransactionRunner };
}

describe("legacy migration audit reader", () => {
  it("strictly reads only unresolved DATABASE markets in one serializable snapshot", async () => {
    const state = fixture();
    const result = await readLegacyMigrationAuditInput(state.client);

    expect(result.markets).toHaveLength(1);
    expect(result.markets[0]).toMatchObject({ id: "market-a", status: "CLOSED", chainCommandStatuses: ["PROJECTED"] });
    expect(state.tx.market.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        executionBackend: "DATABASE",
        status: { in: ["OPEN", "PAUSED", "CLOSED"] },
        resolution: null,
      },
      orderBy: { id: "asc" },
    }));
    expect(state.tx.ledgerAccount.findMany).not.toHaveBeenCalled();
    expect(state.tx.marketOrder.update).not.toHaveBeenCalled();
    expect(state.tx.marketSettlementRun.create).not.toHaveBeenCalled();
    expect(state.transaction).toHaveBeenCalledOnce();
  });

  it("passes the single read snapshot directly into the deterministic builder", async () => {
    const state = fixture();
    const snapshot = await buildLegacyMigrationAuditSnapshot(state.client);

    expect(snapshot.payload.markets).toEqual([expect.objectContaining({ marketId: "market-a", status: "CLOSED" })]);
    expect(snapshot.payload.source).toMatchObject({ marketCount: 1, userCount: 0 });
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an empty canonical snapshot without issuing broad follow-up reads", async () => {
    const state = fixture();
    state.tx.market.findMany.mockResolvedValueOnce([]);

    const snapshot = await buildLegacyMigrationAuditSnapshot(state.client);

    expect(snapshot.payload.markets).toEqual([]);
    expect(snapshot.payload.users).toEqual([]);
    expect(state.tx.ledgerAccount.findMany).not.toHaveBeenCalled();
    expect(state.tx.chainCommand.findMany).not.toHaveBeenCalled();
    expect(state.tx.journalEntry.findMany).not.toHaveBeenCalled();
  });
});
