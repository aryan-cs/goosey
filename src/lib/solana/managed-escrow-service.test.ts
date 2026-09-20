import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), ensure: vi.fn() }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));
vi.mock("@/lib/solana/custody-service", () => ({ ensureAppManagedSolanaIdentity: mocks.ensure }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { acceptManagedEscrowDeposit, managedEscrowCommandEnvelopeSchema } from "./managed-escrow-service";

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE" };
const walletAddress = "EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W";
const market = { id: "market_12345678", executionBackend: "SOLANA", status: "OPEN", collateralAccountId: null,
  solanaBinding: { cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress, chainMarketId: "7" } };

function fixture() {
  const stored = { state: { id: "deposit_command_12345678" } };
  return {
    database: { market: { findUnique: vi.fn(async () => market) }, solanaCustodyIdentity: {} },
    store: { createOrReplay: vi.fn(async (identity: unknown) => { void identity; return stored; }), publicStatus: vi.fn(async () => ({
      id: stored.state.id, operation: "DEPOSIT_ESCROW", status: "ACCEPTED", revision: 0, attemptCount: 0,
    })) },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue(runtime);
  mocks.ensure.mockResolvedValue({ walletAddress });
});

describe("managed escrow command acceptance", () => {
  it("freezes exact funding policy, amount, wallet, market, and parent command", async () => {
    const f = fixture();
    const result = await acceptManagedEscrowDeposit({ userId: "user_12345678", marketSlug: "goosey-market",
      parentCommandId: "order_command_12345678", amount: 505n }, { database: f.database as never, store: f.store as never });
    expect(result.command).toMatchObject({ operation: "DEPOSIT_ESCROW", status: "ACCEPTED" });
    const identity = f.store.createOrReplay.mock.calls[0]![0] as {
      scope: string; scopeId: string; actorId: string; operation: string; idempotencyKey: string; requestJson: string;
    };
    expect(identity).toMatchObject({ scope: "USER", scopeId: "user_12345678", actorId: "user_12345678",
      operation: "DEPOSIT_ESCROW", idempotencyKey: "managed-escrow:v1:order_command_12345678" });
    expect(managedEscrowCommandEnvelopeSchema.parse(JSON.parse(identity.requestJson)).request).toEqual({
      parentCommandId: "order_command_12345678", marketId: market.id, marketSlug: "goosey-market",
      chainMarketId: "7", walletAddress, amount: "505", fundingPolicyVersion: "exact-order-reserve-v1",
    });
  });

  it.each([0n, -1n, 1n << 64n])("rejects invalid amount %s before database work", async amount => {
    const f = fixture();
    await expect(acceptManagedEscrowDeposit({ userId: "user_12345678", marketSlug: "goosey-market",
      parentCommandId: "order_command_12345678", amount }, { database: f.database as never, store: f.store as never }))
      .rejects.toThrow("Invalid managed escrow");
    expect(f.database.market.findUnique).not.toHaveBeenCalled();
  });

  it("rejects deployment drift before accepting a command", async () => {
    const f = fixture();
    f.database.market.findUnique.mockResolvedValue({ ...market,
      solanaBinding: { ...market.solanaBinding, genesisHash: walletAddress } });
    await expect(acceptManagedEscrowDeposit({ userId: "user_12345678", marketSlug: "goosey-market",
      parentCommandId: "order_command_12345678", amount: 1n }, { database: f.database as never, store: f.store as never }))
      .rejects.toMatchObject({ code: "MARKET_DEPLOYMENT_UNAVAILABLE" });
    expect(f.store.createOrReplay).not.toHaveBeenCalled();
  });
});
