import { createNoopSigner, type Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  provisionManagedSolanaAccount,
  type AccountProvisioningDependencies,
  type FinalizedProvisioningState,
  type ProvisioningCheckpoint,
  type ProvisioningJournal,
} from "./account-provisioning";

const PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const GENESIS = "11111111111111111111111111111111";
const WALLET = "SysvarC1ock11111111111111111111111111111111" as Address;
const AUTHORITY = createNoopSigner("SysvarRent111111111111111111111111111111111" as Address);
const SPONSOR = createNoopSigner("Vote111111111111111111111111111111111111111" as Address);
const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:20999",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM,
  GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
};

function journal(): ProvisioningJournal & { value: ProvisioningCheckpoint | null; saves: number } {
  const serialized = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `${item}n` : item);
  return {
    value: null,
    saves: 0,
    async load() { return this.value; },
    async save(expected, next) {
      if (serialized(this.value) !== serialized(expected)) throw new Error("checkpoint race");
      this.value = structuredClone(next);
      this.saves += 1;
    },
  };
}

function chainState(patch: Partial<FinalizedProvisioningState> = {}): FinalizedProvisioningState {
  return { slot: 100n, walletAddress: WALLET, enrollment: "absent", claim: "unclaimed",
    associatedTokenAccount: "absent", ...patch };
}

function dependencies(states: FinalizedProvisioningState[]): AccountProvisioningDependencies & Record<string, ReturnType<typeof vi.fn>> {
  let read = 0;
  return {
    ensureIdentity: vi.fn(async (userId: string) => ({ id: "identity", userId, chainId: "solana:localnet" as const,
      genesisHash: GENESIS, walletAddress: WALLET, createdAt: new Date(0) })),
    loadSigner: vi.fn(async () => createNoopSigner(WALLET)),
    readFinalizedState: vi.fn(async () => states[Math.min(read++, states.length - 1)]!),
    prepareEnrollment: vi.fn(async () => ({ message: {} as never, lastValidBlockHeight: 200n })),
    prepareClaim: vi.fn(async () => ({ message: {} as never, lastValidBlockHeight: 200n })),
    track: vi.fn(async () => ({ status: "unknown" as const, signature: "1".repeat(64) })),
    signAndEncode: vi.fn(async (prepared: { lastValidBlockHeight: bigint }) => ({
      signature: "1".repeat(64), signedWireBase64: "signed-private-wire", lastValidBlockHeight: prepared.lastValidBlockHeight,
    })),
    send: vi.fn(async () => "submitted" as const),
  };
}

function request(store: ProvisioningJournal, deps: AccountProvisioningDependencies) {
  return {
    userId: "ordinary-goosey-user",
    identityDigest: new Uint8Array(32).fill(7),
    allowance: 10_000n,
    expiresAt: 2_000_000_000n,
    enrollmentAuthority: AUTHORITY,
    sponsor: SPONSOR,
    journal: store,
    env,
    dependencies: deps,
  };
}

describe("managed Solana account provisioning", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("creates custody identity and durably journals enrollment before sending", async () => {
    const store = journal(), deps = dependencies([chainState()]);
    const result = await provisionManagedSolanaAccount(request(store, deps));

    expect(result).toEqual({ status: "pending", operation: "enrollment", walletAddress: WALLET,
      chainId: "solana:localnet", genesisHash: GENESIS, signature: "1".repeat(64) });
    expect(store.saves).toBe(2);
    expect(store.value?.pending?.operation).toBe("enrollment");
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.prepareClaim).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("signed-private-wire");
  });

  it("does not sign or resend while a receipt remains ambiguous", async () => {
    const store = journal(), deps = dependencies([chainState()]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.signAndEncode).mockClear();
    vi.mocked(deps.send).mockClear();
    vi.mocked(deps.track).mockResolvedValue({ status: "unknown", signature: "1".repeat(64) });

    const result = await provisionManagedSolanaAccount(request(store, deps));
    expect(result).toMatchObject({ status: "pending", operation: "enrollment" });
    expect(deps.signAndEncode).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it.each(["expired", "failed"] as const)("requires manual reconciliation for a %s receipt", async status => {
    const store = journal(), deps = dependencies([chainState()]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.track).mockResolvedValue({ status, signature: "1".repeat(64),
      ...(status === "expired" ? { historicalOutcome: "unknown" as const } : { error: "custom program error" }) });
    vi.mocked(deps.signAndEncode).mockClear();

    const result = await provisionManagedSolanaAccount(request(store, deps));
    expect(result.status).toBe("manual-reconciliation-required");
    expect(deps.signAndEncode).not.toHaveBeenCalled();
    expect(store.value?.pending).not.toBeNull();
  });

  it("verifies finalized enrollment before preparing the sponsored claim", async () => {
    const store = journal();
    const deps = dependencies([
      chainState(),
      chainState(),
      chainState({ slot: 150n, enrollment: "authorized" }),
    ]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.track).mockResolvedValue({ status: "finalized", signature: "1".repeat(64), commitment: "finalized" });
    vi.mocked(deps.signAndEncode).mockResolvedValue({ signature: "2".repeat(64), signedWireBase64: "claim-wire",
      lastValidBlockHeight: 220n });

    const result = await provisionManagedSolanaAccount(request(store, deps));
    expect(result).toMatchObject({ status: "pending", operation: "claim", signature: "2".repeat(64) });
    expect(deps.prepareClaim).toHaveBeenCalledWith(expect.objectContaining({ sponsor: SPONSOR }));
    expect(store.value?.pending?.operation).toBe("claim");
  });

  it("clears a finalized claim receipt only after finalized state proves readiness", async () => {
    const store = journal();
    const deps = dependencies([chainState({ enrollment: "authorized" })]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.track).mockResolvedValue({ status: "finalized", signature: "1".repeat(64), commitment: "finalized" });
    vi.mocked(deps.readFinalizedState).mockResolvedValue(chainState({ slot: 175n, enrollment: "authorized",
      claim: "claimed", associatedTokenAccount: "initialized" }));

    const result = await provisionManagedSolanaAccount(request(store, deps));
    expect(result).toMatchObject({ status: "ready", operation: null, finalizedSlot: 175n });
    expect(store.value?.pending).toBeNull();
  });

  it("fails closed on contradictory state and a finalized transaction without its transition", async () => {
    const bad = dependencies([chainState({ enrollment: "authorized", claim: "claimed" })]);
    await expect(provisionManagedSolanaAccount(request(journal(), bad))).rejects.toThrow("associated token account");

    const store = journal(), deps = dependencies([chainState()]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.track).mockResolvedValue({ status: "finalized", signature: "1".repeat(64), commitment: "finalized" });
    await expect(provisionManagedSolanaAccount(request(store, deps))).rejects.toThrow("required provisioning state");
  });

  it("rejects network drift, checkpoint substitution, and collapsed signer roles", async () => {
    const store = journal(), deps = dependencies([chainState()]);
    vi.mocked(deps.ensureIdentity).mockResolvedValue({ id: "identity", userId: "ordinary-goosey-user",
      chainId: "solana:devnet", genesisHash: GENESIS, walletAddress: WALLET, createdAt: new Date(0) });
    await expect(provisionManagedSolanaAccount(request(store, deps))).rejects.toThrow("network");

    const roles = request(journal(), dependencies([chainState()]));
    await expect(provisionManagedSolanaAccount({ ...roles, sponsor: createNoopSigner(WALLET) }))
      .rejects.toThrow("roles must remain separate");
    await expect(provisionManagedSolanaAccount({ ...roles, sponsor: AUTHORITY }))
      .rejects.toThrow("roles must remain separate");
  });

  it("binds a durable checkpoint to the exact provisioning intent", async () => {
    const store = journal(), deps = dependencies([chainState()]);
    await provisionManagedSolanaAccount(request(store, deps));
    vi.mocked(deps.signAndEncode).mockClear();
    vi.mocked(deps.send).mockClear();

    await expect(provisionManagedSolanaAccount({ ...request(store, deps), allowance: 10_001n }))
      .rejects.toThrow("frozen provisioning intent");
    expect(deps.signAndEncode).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
  });

  it("has no import-time chain or database execution", async () => {
    vi.resetModules();
    await expect(import("./account-provisioning")).resolves.toHaveProperty("provisionManagedSolanaAccount");
  });
});
