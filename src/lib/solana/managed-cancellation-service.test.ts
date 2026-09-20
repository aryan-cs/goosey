import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import {
  acceptManagedCancellation,
  encodeManagedCancellationReference,
  parseManagedCancellationReference,
} from "./managed-cancellation-service";

const runtime = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};

function database(overrides: Record<string, unknown> = {}) {
  const row = { id: "market_1", executionBackend: "SOLANA", collateralAccountId: null,
    solanaBinding: { cluster: "localnet", genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      programAddress: runtime.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "7" }, ...overrides };
  const stored = new Map<string, Record<string, unknown>>();
  const result = {
    market: { findUnique: vi.fn(async () => row) },
    chainCommand: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) return stored.get(String(where.id)) ?? null;
        return [...stored.values()][0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date("2026-09-20T00:00:00Z");
        const value = { id: "cmd_cancel_123", status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
          leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null,
          acceptedAt: now, preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null,
          finalizedAt: null, projectedAt: null, unknownSince: null, createdAt: now, updatedAt: now, ...data };
        stored.set(String(value.id), value); return value;
      }),
    },
    $transaction: async (operation: (tx: unknown) => unknown) => operation(result),
  };
  return result as never;
}

describe("managed cancellation acceptance", () => {
  it("round-trips a canonical ordinary order identity without exposing a backend label", () => {
    const value = { marketSlug: "market-one", orderId: "18446744073709551615" };
    const encoded = encodeManagedCancellationReference(value);
    expect(encoded.startsWith("g1.")).toBe(true);
    expect(encoded).not.toContain("solana");
    expect(parseManagedCancellationReference(encoded)).toEqual(value);
    expect(parseManagedCancellationReference("database_order_123")).toBeNull();
  });

  it("durably accepts the immutable market-bound cancellation after custody validation", async () => {
    const db = database();
    const ensureIdentity = vi.fn(async () => ({ id: "identity", userId: "user_12345678",
      chainId: "solana:localnet" as const, genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      walletAddress: address("11111111111111111111111111111111"), createdAt: new Date() }));
    const result = await acceptManagedCancellation({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "cancel-request-123",
      expectedVersion: 9 }, { database: db, env: runtime, ensureIdentity, provider: "postgresql" });
    expect(result).toMatchObject({ accepted: true, pending: true,
      command: { id: "cmd_cancel_123", operation: "CANCEL_ORDER", status: "ACCEPTED" } });
    expect(ensureIdentity).toHaveBeenCalledOnce();
    const created = (db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create;
    const requestJson = created.mock.calls[0][0].data.requestJson as string;
    expect(JSON.parse(requestJson)).toEqual({ operation: "CANCEL_ORDER", request: {
      chainMarketId: "7", expectedVersion: 9, marketId: "market_1", marketSlug: "market-one", orderId: "42",
    }, version: 1 });
  });

  it("hides non-managed market identity and rejects malformed managed references", async () => {
    const ensureIdentity = vi.fn();
    await expect(acceptManagedCancellation({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "cancel-request-123" }, {
      database: database({ executionBackend: "DATABASE", solanaBinding: null }), env: runtime, ensureIdentity,
    })).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect(() => parseManagedCancellationReference("g1.not-canonical"))
      .toThrow(expect.objectContaining({ code: "INVALID_ORDER_ID" }));
  });
});
