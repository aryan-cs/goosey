import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedResolutionCommand } from "./managed-resolution-dispatcher";
import type { ManagedResolutionOperation } from "./sponsored-resolution";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const runtime = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const digest = (character: string) => character.repeat(64);

function requestJson(operation: ManagedResolutionOperation): string {
  const request = { chainMarketId: "7", marketId: "market_1", marketSlug: "market-one",
    ...(["PROPOSE_RESOLUTION", "APPROVE_RESOLUTION"].includes(operation)
      ? { sequence: "3", outcome: "YES", reasonDigestSha256: digest("a"), evidenceDigestSha256: digest("b") } : {}) };
  return JSON.stringify({ operation, request, version: 1 });
}

function state(operation: ManagedResolutionOperation, status: StoredChainCommand["state"]["status"], revision: number,
  leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "MARKET",
    scopeId: "market_1", actorId: "user_12345678", operation, idempotencyKey: `intent-${operation.toLowerCase()}`,
    requestHash: "a".repeat(64), requestJson: requestJson(operation) },
  state: { id: "cmd_resolution_1", status, revision, attemptCount: leaseEpoch ? 1 : 0, leaseEpoch,
    lease: leaseEpoch ? { owner: "worker", tokenHash: "hash", epoch: leaseEpoch,
      expiresAt: new Date(date.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt: date, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null },
  createdAt: date, updatedAt: date };
}

function harness(operation: ManagedResolutionOperation) {
  let current = state(operation, "ACCEPTED", 0);
  const events: string[] = [];
  const store = {
    load: vi.fn(async () => current),
    loadLatestWireReference: vi.fn(),
    acquireLease: vi.fn(async () => (current = state(operation, current.state.status, current.state.revision + 1, 1))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
      current = state(operation, input.to, current.state.revision + 1, 1); return current;
    }),
    appendSignedWireBeforeSend: vi.fn(async () => {
      events.push("journal"); current = state(operation, "SIGNED", current.state.revision + 1, 1);
      return { command: current, journal: {} as never };
    }),
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation, status: current.state.status,
      revision: current.state.revision, attemptCount: current.state.attemptCount, acceptedAt: current.state.acceptedAt,
      preparedAt: null, signedAt: null, submittedAt: null, confirmedAt: null, finalizedAt: null,
      projectedAt: null, unknownSince: null, updatedAt: current.updatedAt })),
  };
  const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
    programAddress: PROGRAM as Address, participantAddress: PARTICIPANT, sponsorAddress: SPONSOR,
    signature: "1".repeat(64), signedWireBase64: "wire" as never, messageSha256: "digest",
    recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
  const prepare = vi.fn(async (input: { operation: ManagedResolutionOperation; fingerprint?: { sequence: bigint } }) => ({
    operation: input.operation, signed, market: SPONSOR, resolution: PARTICIPANT, observedSlot: 1n,
  }));
  const submit = vi.fn(async (input: { onPrepared: (value: unknown) => unknown }): Promise<{
    status: "submitted" | "unknown";
    signature: string;
    signedWireBase64: typeof signed.signedWireBase64;
    lastValidBlockHeight: bigint;
  }> => {
    await input.onPrepared({ signature: signed.signature, signedWireBase64: signed.signedWireBase64,
      lastValidBlockHeight: signed.lastValidBlockHeight });
    events.push("submit");
    return { status: "submitted" as const, signature: signed.signature,
      signedWireBase64: signed.signedWireBase64, lastValidBlockHeight: signed.lastValidBlockHeight };
  });
  return { store, events, signed, prepare, submit };
}

describe("managed resolution dispatcher", () => {
  it.each(["CLOSE_RESOLUTION", "PROPOSE_RESOLUTION", "APPROVE_RESOLUTION", "CLAIM_RESOLUTION", "FINALIZE_RESOLUTION"] as const)(
    "journals and finalizes %s without changing the immutable operation",
    async operation => {
      const h = harness(operation);
      const verifyFinalized = vi.fn(async () => ({ finalizedSlot: 8n, phase: 4 }));
      const result = await dispatchManagedResolutionCommand("cmd_resolution_1", { store: h.store as never,
        env: runtime, owner: "worker", now: () => new Date("2026-09-20T00:00:01Z"),
        loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
        loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)), prepare: h.prepare as never, submit: h.submit as never,
        track: vi.fn(async () => ({ status: "finalized" as const, signature: h.signed.signature, executionSlot: 8n })),
        verifyFinalized });
      expect(result.status).toBe("FINALIZED");
      expect(h.events).toEqual(["journal", "submit"]);
      expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ operation, marketId: 7n,
        ...(operation === "PROPOSE_RESOLUTION" || operation === "APPROVE_RESOLUTION"
          ? { fingerprint: expect.objectContaining({ sequence: 3n, outcome: "YES" }) } : {}) }));
      expect(verifyFinalized).toHaveBeenCalledWith(expect.objectContaining({ operation, minimumFinalizedSlot: 8n }));
    },
  );

  it("reconciles a retained wire without preparing, signing, or resubmitting", async () => {
    const h = harness("APPROVE_RESOLUTION");
    const retained = state("APPROVE_RESOLUTION", "SUBMITTED", 4);
    h.store.load.mockResolvedValue(retained);
    h.store.acquireLease.mockImplementation(async () => state("APPROVE_RESOLUTION", "SUBMITTED", 5, 1));
    h.store.loadLatestWireReference.mockResolvedValue({ transactionSignature: h.signed.signature, lastValidBlockHeight: 99n });
    const result = await dispatchManagedResolutionCommand("cmd_resolution_1", { store: h.store as never, env: runtime,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)), prepare: h.prepare as never, submit: h.submit as never,
      track: vi.fn(async () => ({ status: "finalized" as const, signature: h.signed.signature, executionSlot: 8n })),
      verifyFinalized: vi.fn(async () => ({ finalizedSlot: 8n, phase: 3 })) });
    expect(result.status).toBe("FINALIZED");
    expect(h.store.loadLatestWireReference).toHaveBeenCalledOnce();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("marks a post-journal transport ambiguity UNKNOWN and never creates replacement bytes", async () => {
    const h = harness("CLAIM_RESOLUTION");
    h.submit.mockResolvedValue({ status: "unknown", signature: h.signed.signature,
      signedWireBase64: h.signed.signedWireBase64, lastValidBlockHeight: 99n });
    const result = await dispatchManagedResolutionCommand("cmd_resolution_1", { store: h.store as never, env: runtime,
      loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
      loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)), prepare: h.prepare as never, submit: h.submit as never });
    expect(result.status).toBe("UNKNOWN");
    expect(h.events).toEqual(["journal"]);
    expect(h.store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
  });
});
