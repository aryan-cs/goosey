import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { acceptManagedOrder } from "./managed-order-service";

const runtime = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};

function request() {
  return { clientOrderId: "client-order-123", outcome: "YES" as const, action: "BUY" as const,
    limitPriceMilli: "450", quantity: 2, timeInForce: "GTC" as const, postOnly: false,
    selfTradePrevention: "CANCEL_AGGRESSOR" as const, expiresAt: null, cancelOnPause: true as const,
    reduceOnly: false as const };
}

function database(overrides: Record<string, unknown> = {}) {
  const row = { id: "market_1", executionBackend: "SOLANA", status: "OPEN", collateralAccountId: null,
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
        const value = { id: "cmd_12345678", status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
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

describe("managed order acceptance", () => {
  it("creates an app-custodied identity before durably accepting the immutable order", async () => {
    const db = database();
    const ensureIdentity = vi.fn(async () => ({ id: "identity", userId: "user_12345678",
      chainId: "solana:localnet" as const, genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      walletAddress: address("11111111111111111111111111111111"), createdAt: new Date() }));
    const result = await acceptManagedOrder({ userId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "client-order-123", request: request() }, {
      database: db, env: runtime, ensureIdentity, provider: "postgresql",
    });
    expect(result).toMatchObject({ accepted: true, pending: true, command: { id: "cmd_12345678", status: "ACCEPTED" } });
    expect(ensureIdentity).toHaveBeenCalledOnce();
  });

  it("rejects unbound or mismatched deployments before custody creation", async () => {
    const ensureIdentity = vi.fn();
    await expect(acceptManagedOrder({ userId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "client-order-123", request: request() }, {
      database: database({ solanaBinding: null }), env: runtime, ensureIdentity,
    })).rejects.toMatchObject({ code: "MARKET_BACKEND_MISMATCH" });
    expect(ensureIdentity).not.toHaveBeenCalled();
  });

  it.each([
    { limitPriceMilli: "1000000" },
    { expiresAt: "2026-09-20T00:00:00.001Z" },
  ])("rejects an order the on-chain builder cannot represent before custody or command creation", async patch => {
    const db = database();
    const ensureIdentity = vi.fn();
    await expect(acceptManagedOrder({ userId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "client-order-123", request: { ...request(), ...patch } }, {
      database: db, env: runtime, ensureIdentity, provider: "postgresql",
    })).rejects.toThrow();
    expect(ensureIdentity).not.toHaveBeenCalled();
    expect((db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create).not.toHaveBeenCalled();
  });

  it("rejects mismatched HTTP and client idempotency identifiers before database work", async () => {
    const db = database();
    const ensureIdentity = vi.fn();
    await expect(acceptManagedOrder({ userId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "different-request-key", request: request() }, {
      database: db, env: runtime, ensureIdentity, provider: "postgresql",
    })).rejects.toMatchObject({ code: "ORDER_IDEMPOTENCY_MISMATCH" });
    expect((db as never as { market: { findUnique: ReturnType<typeof vi.fn> } }).market.findUnique).not.toHaveBeenCalled();
    expect(ensureIdentity).not.toHaveBeenCalled();
  });
});
