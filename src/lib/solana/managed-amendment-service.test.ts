import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { acceptManagedAmendment } from "./managed-amendment-service";

const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111" };
function database() {
  const stored = new Map<string, Record<string, unknown>>();
  const result = { market: { findUnique: vi.fn(async () => ({ id: "market_1", executionBackend: "SOLANA",
    collateralAccountId: null, solanaBinding: { cluster: "localnet", genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
      programAddress: env.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "7" } })) }, chainCommand: {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => "id" in where
      ? stored.get(String(where.id)) ?? null : [...stored.values()][0] ?? null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const now = new Date();
      const row = { id: "cmd_replace_123", status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
        leaseOwner: null, leaseTokenHash: null, leaseExpiresAt: null, lastErrorCode: null, lastErrorMessage: null,
        acceptedAt: now, preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null, finalizedAt: null,
        projectedAt: null, unknownSince: null, createdAt: now, updatedAt: now, ...data };
      stored.set(String(row.id), row); return row; }),
  }, $transaction: async (operation: (tx: unknown) => unknown) => operation(result) };
  return result as never;
}
const body = { clientOrderId: "replacement-123", limitPriceMilli: "450", quantity: 3, postOnly: false,
  selfTradePrevention: "CANCEL_AGGRESSOR" as const, cancelOnPause: true as const };

describe("managed amendment acceptance", () => {
  it("persists one immutable REPLACE_ORDER command after explicit admission options", async () => {
    const db = database();
    const ensureIdentity = vi.fn(async () => ({ id: "identity", userId: "user_12345678",
      chainId: "solana:localnet" as const, genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
      walletAddress: address("11111111111111111111111111111111"), createdAt: new Date() }));
    const result = await acceptManagedAmendment({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "replace-request-123",
      expectedVersion: 9, request: body }, { database: db, env, ensureIdentity, provider: "postgresql" });
    expect(result).toMatchObject({ accepted: true, pending: true,
      command: { id: "cmd_replace_123", operation: "REPLACE_ORDER", status: "ACCEPTED" } });
    const create = (db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create;
    expect(JSON.parse(create.mock.calls[0][0].data.requestJson)).toEqual({ operation: "REPLACE_ORDER", request: {
      cancelOnPause: true, chainMarketId: "7", clientOrderId: "replacement-123", expectedVersion: 9,
      limitPriceMilli: "450", marketId: "market_1", marketSlug: "market-one", orderId: "42", postOnly: false,
      quantity: 3, selfTradePrevention: "CANCEL_AGGRESSOR" }, version: 1 });
  });

  it("fails closed before custody or command creation when admission-only options are omitted", async () => {
    const db = database(), ensureIdentity = vi.fn();
    await expect(acceptManagedAmendment({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "replace-request-123",
      expectedVersion: 9, request: { clientOrderId: "replacement-123", limitPriceMilli: "450", quantity: 3 } },
    { database: db, env, ensureIdentity })).rejects.toMatchObject({ status: 422,
      code: "MANAGED_REPLACEMENT_OPTIONS_REQUIRED" });
    expect(ensureIdentity).not.toHaveBeenCalled();
  });
});
