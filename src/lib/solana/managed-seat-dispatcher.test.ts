import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedSeatRegistrationCommand, ensureManagedSeatRegistration } from "./managed-seat-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS };
const requestJson = JSON.stringify({ operation: "REGISTER_SEAT", request: { chainMarketId: "7",
  marketId: "market_12345678", marketSlug: "market-one", seatInstructionVersion: 2,
  walletAddress: PARTICIPANT }, version: 1 });

function stored(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "USER",
    scopeId: "user_12345678", actorId: "user_12345678", operation: "REGISTER_SEAT",
    idempotencyKey: "managed-seat:v2:market_12345678", requestHash: "a".repeat(64), requestJson },
  state: { id: "command_12345678", status, revision, attemptCount: leaseEpoch ? 1 : 0, leaseEpoch,
    lease: leaseEpoch ? { owner: "worker", tokenHash: "hash", epoch: leaseEpoch,
      expiresAt: new Date(date.getTime() + 300_000) } : null,
    lastErrorCode: null, lastErrorMessage: null, acceptedAt: date, preparedAt: null, signedAt: null,
    submittedAt: null, confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null },
  createdAt: date, updatedAt: date };
}

function fixture(initial: StoredChainCommand["state"]["status"] = "ACCEPTED") {
  let current = stored(initial, 0);
  const events: string[] = [];
  const store = {
    load: vi.fn(async () => current),
    loadLatestWireReference: vi.fn(async () => ({ transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n })),
    acquireLease: vi.fn(async () => (current = stored(current.state.status, current.state.revision + 1, 1))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
      events.push(input.to);
      current = stored(input.to, current.state.revision + 1,
        ["UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL", "PROJECTED"].includes(input.to) ? 0 : 1);
      return current;
    }),
    appendSignedWireBeforeSend: vi.fn(async () => {
      events.push("JOURNAL"); current = stored("SIGNED", current.state.revision + 1, 1);
      return { command: current, journal: {} as never };
    }),
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "REGISTER_SEAT", status: current.state.status,
      revision: current.state.revision, attemptCount: current.state.attemptCount, acceptedAt: current.state.acceptedAt,
      preparedAt: current.state.preparedAt, signedAt: current.state.signedAt, submittedAt: current.state.submittedAt,
      confirmedAt: null, finalizedAt: null, projectedAt: null, unknownSince: null, updatedAt: current.updatedAt })),
  };
  const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
    programAddress: PROGRAM as Address, participantAddress: PARTICIPANT, sponsorAddress: SPONSOR,
    signature: "1".repeat(64), signedWireBase64: "wire" as never, messageSha256: "digest",
    recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
  const dependencies = { store, env, owner: "worker", now: () => new Date("2026-09-20T00:00:01Z"),
    ensureProvisioned: vi.fn(async () => ({ status: "ready" as const, operation: null,
      walletAddress: PARTICIPANT, chainId: "solana:localnet" as const, genesisHash: GENESIS, finalizedSlot: 1n })),
    loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
    loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)),
    prepare: vi.fn(async () => ({ signed, market: SPONSOR, seats: SPONSOR, enrollment: SPONSOR,
      locator: SPONSOR, observedSlot: 1n, enrollmentSlot: 1n, blockhashSlot: 2n })),
    submit: vi.fn(async (input: { onPrepared: (receipt: typeof signed) => void }) => {
      events.push("SUBMIT"); input.onPrepared(signed); return { status: "submitted" as const,
        signature: signed.signature, signedWireBase64: signed.signedWireBase64, lastValidBlockHeight: 99n };
    }),
    track: vi.fn(async () => ({ status: "finalized" as const, signature: signed.signature })),
  };
  return { store, events, signed, dependencies };
}

describe("managed seat registration dispatcher", () => {
  it("journals exact wire before one send and completes only after finalized tracking", async () => {
    const f = fixture();
    const result = await dispatchManagedSeatRegistrationCommand("command_12345678", f.dependencies);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "SUBMIT", "SUBMITTED", "FINALIZED", "PROJECTED"]);
    expect(result.status).toBe("PROJECTED");
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledWith(expect.objectContaining({ wire: expect.objectContaining({
      feePayerAddress: SPONSOR,
      signerAddresses: [SPONSOR, PARTICIPANT],
      sequence: 1,
    }) }));
    expect(f.dependencies.submit).toHaveBeenCalledOnce();
  });

  it("never leases, signs, or resubmits completed or manually reconciling commands", async () => {
    for (const status of ["UNKNOWN", "FINALIZED", "PROJECTED"] as const) {
      const f = fixture(status);
      expect((await dispatchManagedSeatRegistrationCommand("command_12345678", f.dependencies)).status).toBe(status);
      expect(f.store.acquireLease).not.toHaveBeenCalled();
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
    }
  });

  it.each(["SIGNED", "SUBMITTED", "CONFIRMED"] as const)(
    "reconciles retained %s bytes by exact signature without re-signing or resubmitting",
    async status => {
      const f = fixture(status);
      const result = await dispatchManagedSeatRegistrationCommand("command_12345678", f.dependencies);
      expect(result.status).toBe("PROJECTED");
      expect(f.store.loadLatestWireReference).toHaveBeenCalledWith("command_12345678");
      expect(f.dependencies.track).toHaveBeenCalledWith(expect.objectContaining({
        signature: "1".repeat(64),
        lastValidBlockHeight: 99n,
      }));
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
    },
  );

  it("marks post-journal submission failures UNKNOWN instead of allowing replacement signing", async () => {
    const f = fixture();
    f.dependencies.submit.mockRejectedValueOnce(new Error("transport failed before a response"));
    await expect(dispatchManagedSeatRegistrationCommand("command_12345678", f.dependencies)).rejects.toThrow(/transport/);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
    expect(f.store.transition).toHaveBeenLastCalledWith("command_12345678", expect.objectContaining({ to: "UNKNOWN" }));
  });

  it("rejects custody drift before signing and leaves a retryable fenced command", async () => {
    const f = fixture();
    f.dependencies.loadParticipant.mockResolvedValueOnce(createNoopSigner(SPONSOR));
    await expect(dispatchManagedSeatRegistrationCommand("command_12345678", f.dependencies)).rejects.toThrow(/wallet changed/);
    expect(f.events).toEqual(["PREPARED", "FAILED_RETRYABLE"]);
    expect(f.dependencies.prepare).not.toHaveBeenCalled();
    expect(f.store.appendSignedWireBeforeSend).not.toHaveBeenCalled();
  });

  it("accepts and dispatches automatically while preserving completed replays", async () => {
    const dispatch = vi.fn(async () => ({ status: "PROJECTED" } as never));
    const accept = vi.fn(async () => ({ accepted: true as const, pending: true as const,
      command: { id: "command_12345678", status: "ACCEPTED" } as never }));
    expect(await ensureManagedSeatRegistration({ userId: "user_12345678", marketSlug: "market-one" },
      { accept, dispatch })).toEqual({ status: "PROJECTED" });
    expect(dispatch).toHaveBeenCalledWith("command_12345678", expect.objectContaining({ accept, dispatch }));

    dispatch.mockClear();
    accept.mockResolvedValueOnce({ accepted: true, pending: true,
      command: { id: "command_12345678", status: "PROJECTED" } as never });
    expect((await ensureManagedSeatRegistration({ userId: "user_12345678", marketSlug: "market-one" },
      { accept, dispatch })).status).toBe("PROJECTED");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
