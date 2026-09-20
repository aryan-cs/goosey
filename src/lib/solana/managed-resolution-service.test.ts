import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { acceptManagedResolutionCommand, type ManagedResolutionIntent } from "./managed-resolution-service";

const runtime = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};
const fingerprint = { sequence: "3", outcome: "YES" as const,
  reasonDigestSha256: "a".repeat(64), evidenceDigestSha256: "b".repeat(64) };

function database(overrides: Record<string, unknown> = {}) {
  const row = { id: "market_1", executionBackend: "SOLANA", collateralAccountId: null,
    solanaBinding: { cluster: "localnet", genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      programAddress: runtime.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "7" }, ...overrides };
  const stored = new Map<string, Record<string, unknown>>();
  const result = {
    market: { findUnique: vi.fn(async () => row) },
    user: { findUnique: vi.fn(async () => ({ role: "ADMIN", status: "ACTIVE" })) },
    chainCommand: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ("id" in where) return stored.get(String(where.id)) ?? null;
        return [...stored.values()][0] ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date("2026-09-20T00:00:00Z");
        const value = { id: `cmd_${stored.size}`, status: "ACCEPTED", revision: 0, attemptCount: 0, leaseEpoch: 0,
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

const cases: Array<[ManagedResolutionIntent, "USER" | "MARKET"]> = [
  [{ operation: "CLOSE_RESOLUTION" }, "MARKET"],
  [{ operation: "PROPOSE_RESOLUTION", ...fingerprint }, "MARKET"],
  [{ operation: "APPROVE_RESOLUTION", ...fingerprint }, "MARKET"],
  [{ operation: "CLAIM_RESOLUTION" }, "USER"],
  [{ operation: "FINALIZE_RESOLUTION" }, "MARKET"],
];

describe("managed resolution acceptance", () => {
  it.each(cases)("durably accepts %s with canonical deployment and scope", async (intent, scope) => {
    const db = database();
    const ensureIdentity = vi.fn(async () => ({ id: "identity", userId: "user_12345678",
      chainId: "solana:localnet" as const, genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      walletAddress: address("11111111111111111111111111111111"), createdAt: new Date() }));
    const result = await acceptManagedResolutionCommand({ actorUserId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: `resolution-${intent.operation.toLowerCase()}`, intent },
    { database: db, env: runtime, ensureIdentity, provider: "postgresql" });
    expect(result).toMatchObject({ accepted: true, pending: true,
      command: { operation: intent.operation, status: "ACCEPTED" } });
    const created = (db as never as { chainCommand: { create: ReturnType<typeof vi.fn> } }).chainCommand.create;
    expect(created.mock.calls[0][0].data).toMatchObject({ operation: intent.operation, scope,
      scopeId: scope === "USER" ? "user_12345678" : "market_1", actorId: "user_12345678" });
    expect(JSON.parse(created.mock.calls[0][0].data.requestJson)).toEqual({
      operation: intent.operation,
      request: { chainMarketId: "7", marketId: "market_1", marketSlug: "market-one",
        ...Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "operation")) },
      version: 1,
    });
  });

  it("fails closed before custody access for a mismatched deployment", async () => {
    const ensureIdentity = vi.fn();
    await expect(acceptManagedResolutionCommand({ actorUserId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "resolution-close", intent: { operation: "CLOSE_RESOLUTION" } }, {
      database: database({ solanaBinding: { cluster: "devnet", genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
        programAddress: runtime.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "7" } }),
      env: runtime,
      ensureIdentity,
    })).rejects.toMatchObject({ code: "MARKET_DEPLOYMENT_UNAVAILABLE" });
    expect(ensureIdentity).not.toHaveBeenCalled();
  });

  it("requires an active admin for operational steps but permits a user to claim their own seat", async () => {
    const db = database() as never as { user: { findUnique: ReturnType<typeof vi.fn> } };
    db.user.findUnique.mockResolvedValue({ role: "USER", status: "ACTIVE" });
    const ensureIdentity = vi.fn(async () => ({ id: "identity", userId: "user_12345678",
      chainId: "solana:localnet" as const, genesisHash: runtime.GOOSEY_SOLANA_GENESIS_HASH,
      walletAddress: address("11111111111111111111111111111111"), createdAt: new Date() }));
    await expect(acceptManagedResolutionCommand({ actorUserId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "resolution-close", intent: { operation: "CLOSE_RESOLUTION" } }, {
      database: db as never, env: runtime, ensureIdentity,
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    await expect(acceptManagedResolutionCommand({ actorUserId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: "resolution-claim", intent: { operation: "CLAIM_RESOLUTION" } }, {
      database: db as never, env: runtime, ensureIdentity, provider: "postgresql",
    })).resolves.toMatchObject({ command: { operation: "CLAIM_RESOLUTION" } });
  });
});
