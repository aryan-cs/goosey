import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { AcceptedChainCommandIdentity } from "./chain-command";
import { acceptManagedSeatRegistration } from "./managed-seat-service";

const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: "Vote111111111111111111111111111111111111111",
  GOOSEY_SOLANA_GENESIS_HASH: "Stake11111111111111111111111111111111111111",
};
const walletAddress = address("SysvarRent111111111111111111111111111111111");

function fixture(overrides: Record<string, unknown> = {}) {
  const market = { id: "market_12345678", executionBackend: "SOLANA", status: "OPEN",
    collateralAccountId: null, solanaBinding: { cluster: "localnet", genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
      programAddress: env.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "7" }, ...overrides };
  const database = { market: { findUnique: vi.fn(async () => market) } };
  const ensureIdentity = vi.fn(async () => ({ id: "identity_12345678", userId: "user_12345678",
    chainId: "solana:localnet" as const, genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
    walletAddress, createdAt: new Date("2026-09-20T00:00:00Z") }));
  const stored = { state: { id: "command_12345678" } };
  let captured: AcceptedChainCommandIdentity | undefined;
  const store = { createOrReplay: vi.fn(async (identity: AcceptedChainCommandIdentity) => {
    captured = identity; return stored;
  }), publicStatus: vi.fn(async () => ({
    id: stored.state.id, operation: "REGISTER_SEAT", status: "ACCEPTED" as const, revision: 0, attemptCount: 0,
    acceptedAt: new Date(), preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null,
    finalizedAt: null, projectedAt: null, unknownSince: null, updatedAt: new Date(),
  })) };
  return { database, ensureIdentity, store, captured: () => captured };
}

describe("managed seat registration acceptance", () => {
  it("freezes the bound market and custody wallet into one deterministic command", async () => {
    const f = fixture();
    const result = await acceptManagedSeatRegistration({ userId: "user_12345678", marketSlug: "market-one" }, {
      database: f.database as never, ensureIdentity: f.ensureIdentity, store: f.store as never, env,
    });
    expect(result).toMatchObject({ accepted: true, pending: true,
      command: { id: "command_12345678", operation: "REGISTER_SEAT", status: "ACCEPTED" } });
    const identity = f.captured()!;
    expect(identity).toMatchObject({ scope: "USER", scopeId: "user_12345678", actorId: "user_12345678",
      operation: "REGISTER_SEAT", idempotencyKey: "managed-seat:v2:market_12345678" });
    expect(JSON.parse(identity.requestJson).request).toEqual({ chainMarketId: "7", marketId: "market_12345678",
      seatInstructionVersion: 2,
      marketSlug: "market-one", walletAddress });
  });

  it("rejects non-Solana, closed, or deployment-mismatched markets before custody creation", async () => {
    for (const override of [
      { executionBackend: "DATABASE" },
      { status: "CLOSED" },
      { solanaBinding: { cluster: "localnet", genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH,
        programAddress: env.GOOSEY_SOLANA_PROGRAM_ID, chainMarketId: "18446744073709551616" } },
    ]) {
      const f = fixture(override);
      await expect(acceptManagedSeatRegistration({ userId: "user_12345678", marketSlug: "market-one" }, {
        database: f.database as never, ensureIdentity: f.ensureIdentity, store: f.store as never, env,
      })).rejects.toThrow();
      expect(f.ensureIdentity).not.toHaveBeenCalled();
      expect(f.store.createOrReplay).not.toHaveBeenCalled();
    }
  });
});
