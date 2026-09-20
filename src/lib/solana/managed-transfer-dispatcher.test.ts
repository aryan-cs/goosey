import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedFeatherTransferCommand, ensureManagedFeatherTransfer } from "./managed-transfer-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const SENDER = "SysvarRent111111111111111111111111111111111" as Address;
const RECIPIENT = "SysvarC1ock11111111111111111111111111111111" as Address;
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM, GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
  GOOSEY_SOLANA_SPONSOR_ADDRESS: SPONSOR };
const requestJson = JSON.stringify({ operation: "TRANSFER_FEATHERS", request: {
  recipientUserId: "recipient_12345678", senderWalletAddress: SENDER, recipientWalletAddress: RECIPIENT,
  sponsorAddress: SPONSOR, amount: "505", transferPolicyVersion: "managed-sponsored-spl-v1",
}, version: 1 });

function stored(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return { identity: { cluster: "localnet", genesisHash: GENESIS, programAddress: PROGRAM, scope: "USER",
    scopeId: "sender_12345678", actorId: "sender_12345678", operation: "TRANSFER_FEATHERS",
    idempotencyKey: "transfer-request-123", requestHash: "a".repeat(64), requestJson },
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
  const reference = { transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n };
  const store = {
    load: vi.fn(async () => current),
    loadLatestWireReference: vi.fn(async () => reference),
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
    publicStatus: vi.fn(async () => ({ id: current.state.id, operation: "TRANSFER_FEATHERS",
      status: current.state.status, revision: current.state.revision, attemptCount: current.state.attemptCount,
      acceptedAt: current.state.acceptedAt, preparedAt: current.state.preparedAt, signedAt: current.state.signedAt,
      submittedAt: current.state.submittedAt, confirmedAt: null, finalizedAt: null, projectedAt: null,
      unknownSince: null, updatedAt: current.updatedAt })),
  };
  const signed = { version: 1 as const, cluster: "localnet" as const, genesisHash: GENESIS,
    programAddress: PROGRAM as Address, participantAddress: SENDER, sponsorAddress: SPONSOR,
    signature: reference.transactionSignature, signedWireBase64: "wire" as never, messageSha256: "digest",
    recentBlockhash: SPONSOR, lastValidBlockHeight: 99n };
  const dependencies = { store, env, owner: "worker", now: () => new Date("2026-09-20T00:00:01Z"),
    ensureProvisioned: vi.fn(async () => ({ status: "ready" as const, operation: null,
      walletAddress: SENDER, chainId: "solana:localnet" as const, genesisHash: GENESIS, finalizedSlot: 1n })),
    loadParticipant: vi.fn(async () => createNoopSigner(SENDER)),
    loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)),
    prepare: vi.fn(async () => ({ signed, mint: SPONSOR, sender: SENDER, recipient: RECIPIENT,
      source: SENDER, destination: RECIPIENT, amount: 505n, finalizedBalance: 1_000n, observedSlot: 1n })),
    submit: vi.fn(async (input: { onPrepared: (receipt: typeof signed) => void }) => {
      events.push("SUBMIT"); input.onPrepared(signed); return { status: "submitted" as const,
        signature: signed.signature, signedWireBase64: signed.signedWireBase64, lastValidBlockHeight: 99n };
    }),
    track: vi.fn(async () => ({ status: "finalized" as const, signature: signed.signature })),
  };
  return { store, events, signed, dependencies };
}

describe("managed feather transfer dispatcher", () => {
  it("provisions, freezes signer policy, journals exact wire, sends once, and finalizes", async () => {
    const f = fixture();
    const result = await dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "SUBMIT", "SUBMITTED", "FINALIZED"]);
    expect(result.status).toBe("FINALIZED");
    expect(f.dependencies.ensureProvisioned).toHaveBeenCalledWith(expect.objectContaining({ userId: "sender_12345678" }));
    expect(f.dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ recipient: RECIPIENT, amount: 505n }));
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledWith(expect.objectContaining({ wire: expect.objectContaining({
      transactionSignature: f.signed.signature, signedWireBase64: f.signed.signedWireBase64,
      feePayerAddress: SPONSOR, signerAddresses: [SPONSOR, SENDER], sequence: 1,
    }) }));
    expect(f.dependencies.submit).toHaveBeenCalledOnce();
  });

  it.each(["SIGNED", "SUBMITTED"] as const)("reconciles retained %s wire without signing or resending", async status => {
    const f = fixture(status);
    expect((await dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies)).status).toBe("FINALIZED");
    expect(f.store.loadLatestWireReference).toHaveBeenCalledOnce();
    expect(f.dependencies.prepare).not.toHaveBeenCalled();
    expect(f.dependencies.submit).not.toHaveBeenCalled();
    expect(f.events).toEqual(status === "SIGNED" ? ["SUBMITTED", "FINALIZED"] : ["FINALIZED"]);
  });

  it.each(["FINALIZED", "PROJECTED", "FAILED_TERMINAL"] as const)(
    "does not lease or replace a %s command", async status => {
      const f = fixture(status);
      expect((await dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies)).status).toBe(status);
      expect(f.store.acquireLease).not.toHaveBeenCalled();
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
    });

  it("marks every post-journal throw UNKNOWN", async () => {
    const f = fixture();
    f.dependencies.submit.mockRejectedValueOnce(new Error("transport failed before response"));
    await expect(dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies)).rejects.toThrow(/transport/);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
  });

  it("never tracks or retries an ambiguous send result", async () => {
    const f = fixture();
    f.dependencies.submit.mockResolvedValueOnce({ status: "unknown", signature: f.signed.signature,
      signedWireBase64: f.signed.signedWireBase64, lastValidBlockHeight: 99n } as never);
    expect((await dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies)).status).toBe("UNKNOWN");
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
    expect(f.dependencies.track).not.toHaveBeenCalled();
  });

  it("fails retryably before signing when custody or sponsor identity drifts", async () => {
    for (const drift of ["participant", "sponsor"] as const) {
      const f = fixture();
      if (drift === "participant") f.dependencies.loadParticipant.mockResolvedValueOnce(createNoopSigner(RECIPIENT));
      else f.dependencies.loadSponsor.mockResolvedValueOnce(createNoopSigner(RECIPIENT));
      await expect(dispatchManagedFeatherTransferCommand("command_12345678", f.dependencies)).rejects.toThrow(/signer changed/);
      expect(f.events).toEqual(["PREPARED", "FAILED_RETRYABLE"]);
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.store.appendSignedWireBeforeSend).not.toHaveBeenCalled();
    }
  });

  it("accepts/replays then dispatches active and UNKNOWN commands for exact-signature reconciliation", async () => {
    const dispatch = vi.fn(async () => ({ status: "FINALIZED" } as never));
    const accept = vi.fn(async () => ({ accepted: true as const, pending: true as const,
      command: { id: "command_12345678", status: "ACCEPTED" } as never }));
    const input = { senderUserId: "sender_12345678", idempotencyKey: "transfer-request-123",
      request: { recipientUserId: "recipient_12345678", amount: "0.505" } };
    expect(await ensureManagedFeatherTransfer(input, { accept, dispatch })).toEqual({ status: "FINALIZED" });
    expect(dispatch).toHaveBeenCalledOnce();
    dispatch.mockClear();
    accept.mockResolvedValueOnce({ accepted: true, pending: true,
      command: { id: "command_12345678", status: "UNKNOWN" } as never });
    expect((await ensureManagedFeatherTransfer(input, { accept, dispatch })).status).toBe("FINALIZED");
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
