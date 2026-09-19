import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { readReconciliationSnapshot } from "./reconciliation-snapshot";
import type { TransactionRunner } from "./serializable-transaction";

function fixture(overrides: { accountsError?: Error } = {}) {
  const journals = [{ id: "journal-snapshot" }];
  const accounts = [{ id: "account-snapshot" }];
  const users = [{ id: "user-snapshot" }];
  const markets = [{ id: "market-snapshot" }];
  const tx = {
    journalEntry: { findMany: vi.fn().mockResolvedValue(journals) },
    ledgerAccount: {
      findMany: overrides.accountsError
        ? vi.fn().mockRejectedValue(overrides.accountsError)
        : vi.fn().mockResolvedValue(accounts),
    },
    user: { findMany: vi.fn().mockResolvedValue(users) },
    market: { findMany: vi.fn().mockResolvedValue(markets) },
  };
  const rootReads = {
    journalEntry: { findMany: vi.fn() },
    ledgerAccount: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    market: { findMany: vi.fn() },
  };
  const transaction = vi.fn(async (
    operation: (client: typeof tx) => Promise<unknown>,
    options?: { isolationLevel: Prisma.TransactionIsolationLevel },
  ) => {
    expect(options?.isolationLevel).toBe(Prisma.TransactionIsolationLevel.Serializable);
    return operation(tx);
  });
  const client = { $transaction: transaction, ...rootReads } as unknown as TransactionRunner;
  return { client, transaction, tx, rootReads, journals, accounts, users, markets };
}

describe("reconciliation snapshot reader", () => {
  it("loads every projection from one serializable transaction and maps each result", async () => {
    const state = fixture();

    const result = await readReconciliationSnapshot(state.client);

    expect(result).toEqual({
      journals: state.journals,
      accounts: state.accounts,
      users: state.users,
      markets: state.markets,
    });
    expect(result.journals).toBe(state.journals);
    expect(result.accounts).toBe(state.accounts);
    expect(result.users).toBe(state.users);
    expect(result.markets).toBe(state.markets);
    expect(state.transaction).toHaveBeenCalledOnce();
    expect(state.transaction.mock.calls[0]?.[1]).toMatchObject({
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });

    expect(state.tx.journalEntry.findMany).toHaveBeenCalledWith({ include: { postings: true } });
    expect(state.tx.ledgerAccount.findMany).toHaveBeenCalledWith({
      include: { postings: { include: { journalEntry: { select: { status: true } } } } },
    });
    expect(state.tx.user.findMany).toHaveBeenCalledWith({ where: { role: "USER" } });
    expect(state.tx.market.findMany).toHaveBeenCalledWith({
      where: { executionBackend: "DATABASE" },
      include: {
        collateralAccount: true,
        positions: true,
        orders: { include: { reservation: true } },
        orderFills: { select: { id: true, journalEntryId: true } },
        orderReservations: true,
      },
    });
    for (const repository of Object.values(state.rootReads)) {
      expect(repository.findMany).not.toHaveBeenCalled();
    }
  });

  it("propagates a failed snapshot read instead of returning a partial report", async () => {
    const failure = new Error("account snapshot unavailable");
    const state = fixture({ accountsError: failure });

    await expect(readReconciliationSnapshot(state.client)).rejects.toBe(failure);

    expect(state.transaction).toHaveBeenCalledOnce();
    for (const repository of Object.values(state.rootReads)) {
      expect(repository.findMany).not.toHaveBeenCalled();
    }
  });
});
