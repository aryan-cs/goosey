import { describe, expect, it, vi } from "vitest";

import {
  databaseProviderFromUrl,
  isRetryableTransactionError,
  runSerializableTransaction,
  type TransactionRunner,
} from "./serializable-transaction";

function codedError(code: string, message = code): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("provider-aware serializable transactions", () => {
  it("detects PostgreSQL URLs and defaults non-PostgreSQL URLs to SQLite", () => {
    expect(databaseProviderFromUrl("postgresql://db/goosey")).toBe("postgresql");
    expect(databaseProviderFromUrl("postgres://db/goosey")).toBe("postgresql");
    expect(databaseProviderFromUrl("file:./dev.db")).toBe("sqlite");
  });

  it("retries only P2034 for PostgreSQL and never P2028", () => {
    expect(isRetryableTransactionError(codedError("P2034"), "postgresql")).toBe(true);
    expect(isRetryableTransactionError(codedError("P2028", "database is locked"), "postgresql")).toBe(false);
    expect(isRetryableTransactionError(codedError("P2028", "database is locked"), "sqlite")).toBe(false);
    expect(isRetryableTransactionError(codedError("P2002"), "postgresql")).toBe(false);
    expect(isRetryableTransactionError(codedError("P2034"), "sqlite")).toBe(false);
  });

  it("retries SQLite busy and locked errors only for SQLite", () => {
    expect(isRetryableTransactionError(codedError("SQLITE_BUSY"), "sqlite")).toBe(true);
    expect(isRetryableTransactionError(new Error("database table is locked"), "sqlite")).toBe(true);
    expect(isRetryableTransactionError(new Error("SQLITE_LOCKED_SHAREDCACHE"), "sqlite")).toBe(true);
    expect(isRetryableTransactionError(new Error("database is locked"), "postgresql")).toBe(false);
  });

  it("uses bounded exponential backoff with injectable deterministic jitter", async () => {
    const transaction = vi.fn()
      .mockRejectedValueOnce(codedError("P2034"))
      .mockRejectedValueOnce(codedError("P2034"))
      .mockResolvedValue("committed");
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(runSerializableTransaction(
      { $transaction: transaction } as TransactionRunner,
      async () => "unused",
      { provider: "postgresql", attempts: 4, baseDelayMs: 20, maxDelayMs: 30, jitterRatio: 0.5, random: () => 1, sleep, onRetry },
    )).resolves.toBe("committed");

    expect(sleep.mock.calls).toEqual([[30], [30]]);
    expect(onRetry.mock.calls.map(([event]) => ({ attempt: event.attempt, delayMs: event.delayMs }))).toEqual([
      { attempt: 1, delayMs: 30 },
      { attempt: 2, delayMs: 30 },
    ]);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(transaction.mock.calls[0]?.[1]).toMatchObject({ isolationLevel: "Serializable" });
  });

  it("does not sleep or retry non-retryable and exhausted failures", async () => {
    const p2028 = codedError("P2028");
    const transaction = vi.fn().mockRejectedValue(p2028);
    const sleep = vi.fn();
    await expect(runSerializableTransaction(
      { $transaction: transaction } as TransactionRunner,
      async () => undefined,
      { provider: "postgresql", sleep },
    )).rejects.toBe(p2028);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const conflict = codedError("P2034");
    transaction.mockReset().mockRejectedValue(conflict);
    await expect(runSerializableTransaction(
      { $transaction: transaction } as TransactionRunner,
      async () => undefined,
      { provider: "postgresql", attempts: 2, jitterRatio: 0, sleep },
    )).rejects.toBe(conflict);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("reuses the same callback closure across attempts for stable operation context", async () => {
    const operationId = "operation-stable";
    const operationAt = new Date("2026-09-19T00:00:00.000Z");
    const observed: unknown[] = [];
    const transaction = vi.fn()
      .mockImplementationOnce(async (operation: (tx: unknown) => Promise<unknown>) => {
        observed.push(await operation({ attempt: 1 }));
        throw codedError("P2034");
      })
      .mockImplementationOnce(async (operation: (tx: unknown) => Promise<unknown>) => operation({ attempt: 2 }));

    const result = await runSerializableTransaction(
      { $transaction: transaction } as TransactionRunner,
      async () => ({ operationId, operationAt }),
      { provider: "postgresql", jitterRatio: 0, sleep: async () => undefined },
    );
    expect(observed[0]).toEqual({ operationId, operationAt });
    expect(result).toEqual({ operationId, operationAt });
  });
});
