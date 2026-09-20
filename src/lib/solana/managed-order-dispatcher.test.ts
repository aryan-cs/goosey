import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedOrderCommand } from "./managed-order-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const runtime = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const requestJson = JSON.stringify({ operation: "PLACE_ORDER", request: { action: "BUY", cancelOnPause: true,
  chainMarketId: "7", clientOrderId: "client-order-123", expiresAt: null, limitPriceMilli: "450",
  marketId: "market_1", marketSlug: "market-one", outcome: "YES", postOnly: false, quantity: 2,
  reduceOnly: false, selfTradePrevention: "CANCEL_AGGRESSOR", timeInForce: "GTC" }, version: 1 });

function state(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "USER",
    scopeId: "user_12345678", actorId: "user_12345678", operation: "PLACE_ORDER",
    idempotencyKey: "request-key-123456", requestHash: "a".repeat(64), requestJson },
  state: { id: "cmd_12345678", status, revision, attemptCount: leaseEpoch ? 1 : 0, leaseEpoch,
    lease: leaseEpoch ? { owner: "worker", tokenHash: "hash", epoch: leaseEpoch, expiresAt: new Date(date.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt: date, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null },
  createdAt: date, updatedAt: date };
}

describe("managed order dispatcher", () => {
  it("journals the exact signed wire before the first submission", async () => {
    let current = state("ACCEPTED", 0);
    const events: string[] = [];
    const store = {
      load: vi.fn(async () => current),
      acquireLease: vi.fn(async () => (current = state("ACCEPTED", 1, 1))),
      transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
        current = state(input.to, current.state.revision + 1, input.to === "UNKNOWN" ? 1 : current.state.leaseEpoch);
        return current;
      }),
      appendSignedWireBeforeSend: vi.fn(async () => { events.push("journal"); current = state("SIGNED", 3, 1);
        return { command: current, journal: {} as never }; }),
      loadLatestWireReference: vi.fn(),
      publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "PLACE_ORDER", status: current.state.status,
        revision: current.state.revision, attemptCount: current.state.attemptCount, acceptedAt: current.state.acceptedAt,
        preparedAt: current.state.preparedAt, signedAt: current.state.signedAt, submittedAt: current.state.submittedAt,
        confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null, updatedAt: current.updatedAt })),
    };
    const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
      programAddress: PROGRAM as Address, participantAddress: PARTICIPANT, sponsorAddress: SPONSOR,
      signature: "1".repeat(64), signedWireBase64: "wire" as never, messageSha256: "digest",
      recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
    const submit = vi.fn(async () => { events.push("submit"); return { status: "submitted" as const,
      signature: signed.signature, signedWireBase64: signed.signedWireBase64, lastValidBlockHeight: 99n }; });
    const result = await dispatchManagedOrderCommand("cmd_12345678", { store, env: runtime, owner: "worker",
      now: () => new Date("2026-09-20T00:00:01Z"), loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      ensureProvisioned: vi.fn(async () => ({ status: "ready" as const, operation: null, walletAddress: PARTICIPANT,
        chainId: "solana:localnet" as const, genesisHash: GENESIS, finalizedSlot: 1n })),
      ensureSeat: vi.fn(async () => ({ status: "PROJECTED" } as never)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)), prepare: vi.fn(async () => ({ signed,
        market: SPONSOR, book: SPONSOR, expectedNonce: 0n, observedSlot: 1n, bookRevision: 1n })), submit,
      track: vi.fn(async () => ({ status: "finalized" as const, signature: signed.signature })) });
    expect(events).toEqual(["journal", "submit"]);
    expect(result.status).toBe("FINALIZED");
    expect(store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
  });

  it("never resubmits an ambiguous command", async () => {
    const current = state("UNKNOWN", 4, 1);
    const store = { load: vi.fn(async () => current), publicStatus: vi.fn(async () => ({ status: "UNKNOWN" })),
      loadLatestWireReference: vi.fn(), acquireLease: vi.fn(), transition: vi.fn(), appendSignedWireBeforeSend: vi.fn() };
    expect(await dispatchManagedOrderCommand("cmd_12345678", { store: store as never, env: runtime }))
      .toEqual({ status: "UNKNOWN" });
    expect(store.acquireLease).not.toHaveBeenCalled();
  });

  it.each(["SIGNED", "SUBMITTED", "CONFIRMED"] as const)("reconciles a retained %s wire without signing or resubmitting", async status => {
    let current = state(status, 4);
    const prepare = vi.fn(), submit = vi.fn(), ensureProvisioned = vi.fn();
    const store = {
      load: vi.fn(async () => current),
      loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
      acquireLease: vi.fn(async () => (current = state(status, 5, 1))),
      transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) =>
        (current = state(input.to, current.state.revision + 1, 1))),
      appendSignedWireBeforeSend: vi.fn(),
      publicStatus: vi.fn(async () => ({ status: current.state.status })),
    };
    const result = await dispatchManagedOrderCommand("cmd_12345678", { store: store as never, env: runtime,
      prepare, submit, ensureProvisioned,
      track: vi.fn(async () => ({ status: "finalized" as const, signature: "1".repeat(64) })) });
    expect(result).toEqual({ status: "FINALIZED" });
    expect(store.loadLatestWireReference).toHaveBeenCalledWith("cmd_12345678");
    expect(ensureProvisioned).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("retains an inconclusive recovered wire as UNKNOWN without creating a replacement", async () => {
    let current = state("SIGNED", 4);
    const prepare = vi.fn(), submit = vi.fn();
    const store = {
      load: vi.fn(async () => current),
      loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
      acquireLease: vi.fn(async () => (current = state("SIGNED", 5, 1))),
      transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) =>
        (current = state(input.to, current.state.revision + 1, input.to === "UNKNOWN" ? 0 : 1))),
      appendSignedWireBeforeSend: vi.fn(),
      publicStatus: vi.fn(async () => ({ status: current.state.status })),
    };
    const result = await dispatchManagedOrderCommand("cmd_12345678", { store: store as never, env: runtime,
      prepare, submit, track: vi.fn(async () => ({ status: "expired" as const,
        signature: "1".repeat(64), historicalOutcome: "unknown" as const })) });
    expect(result).toEqual({ status: "UNKNOWN" });
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not prepare or sign an order until managed provisioning is finalized", async () => {
    let current = state("ACCEPTED", 0);
    const prepare = vi.fn(), submit = vi.fn();
    const transitions: string[] = [];
    const store = {
      load: vi.fn(async () => current), loadLatestWireReference: vi.fn(),
      acquireLease: vi.fn(async () => (current = state("ACCEPTED", 1, 1))),
      transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
        transitions.push(input.to);
        current = state(input.to, current.state.revision + 1, input.to === "FAILED_RETRYABLE" ? 0 : 1);
        return current;
      }),
      appendSignedWireBeforeSend: vi.fn(), publicStatus: vi.fn(),
    };
    await expect(dispatchManagedOrderCommand("cmd_12345678", { store: store as never, env: runtime,
      ensureProvisioned: vi.fn(async () => ({ status: "pending" as const, operation: "enrollment" as const,
        walletAddress: PARTICIPANT, chainId: "solana:localnet" as const, genesisHash: GENESIS })),
      prepare, submit })).rejects.toThrow(/still provisioning/);
    expect(transitions).toEqual(["PREPARED", "FAILED_RETRYABLE"]);
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(store.appendSignedWireBeforeSend).not.toHaveBeenCalled();
  });
});
