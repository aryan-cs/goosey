import { createNoopSigner, type Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import type { StoredChainCommand } from "./chain-command-store";
import { dispatchManagedEscrowDepositCommand, ensureManagedEscrowDeposit } from "./managed-escrow-dispatcher";

const PROGRAM = "Vote111111111111111111111111111111111111111";
const GENESIS = "Stake11111111111111111111111111111111111111";
const SPONSOR = "11111111111111111111111111111111" as Address;
const PARTICIPANT = "SysvarRent111111111111111111111111111111111" as Address;
const env = {
  GOOSEY_SOLANA_CLUSTER: "localnet",
  GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:8899",
  GOOSEY_SOLANA_PROGRAM_ID: PROGRAM,
  GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
};
const requestJson = JSON.stringify({
  operation: "DEPOSIT_ESCROW",
  request: {
    parentCommandId: "parent_command_12345678",
    marketId: "market_12345678",
    marketSlug: "market-one",
    chainMarketId: "7",
    walletAddress: PARTICIPANT,
    amount: "505",
    fundingPolicyVersion: "exact-order-reserve-v1",
  },
  version: 1,
});

function stored(status: StoredChainCommand["state"]["status"], revision: number, leaseEpoch = 0): StoredChainCommand {
  const date = new Date("2026-09-20T00:00:00Z");
  return {
    identity: {
      cluster: "localnet",
      genesisHash: GENESIS,
      programAddress: PROGRAM,
      scope: "USER",
      scopeId: "user_12345678",
      actorId: "user_12345678",
      operation: "DEPOSIT_ESCROW",
      idempotencyKey: "managed-escrow:v1:parent_command_12345678",
      requestHash: "a".repeat(64),
      requestJson,
    },
    state: {
      id: "command_12345678",
      status,
      revision,
      attemptCount: leaseEpoch ? 1 : 0,
      leaseEpoch,
      lease: leaseEpoch ? {
        owner: "worker",
        tokenHash: "hash",
        epoch: leaseEpoch,
        expiresAt: new Date(date.getTime() + 300_000),
      } : null,
      lastErrorCode: null,
      lastErrorMessage: null,
      acceptedAt: date,
      preparedAt: null,
      signedAt: null,
      submittedAt: null,
      confirmedAt: null,
      finalizedAt: null,
      projectedAt: null,
      unknownSince: null,
    },
    createdAt: date,
    updatedAt: date,
  };
}

function fixture(initial: StoredChainCommand["state"]["status"] = "ACCEPTED") {
  let current = stored(initial, 0);
  const events: string[] = [];
  const wireReference = { transactionSignature: "1".repeat(64), lastValidBlockHeight: 99n };
  const store = {
    load: vi.fn(async () => current),
    loadLatestWireReference: vi.fn(async () => wireReference),
    acquireLease: vi.fn(async () => (current = stored(current.state.status, current.state.revision + 1, 1))),
    transition: vi.fn(async (_id: string, input: { to: StoredChainCommand["state"]["status"] }) => {
      events.push(input.to);
      current = stored(input.to, current.state.revision + 1,
        ["UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL", "PROJECTED"].includes(input.to) ? 0 : 1);
      return current;
    }),
    appendSignedWireBeforeSend: vi.fn(async () => {
      events.push("JOURNAL");
      current = stored("SIGNED", current.state.revision + 1, 1);
      return { command: current, journal: {} as never };
    }),
    publicStatus: vi.fn(async () => ({
      id: current.state.id,
      operation: "DEPOSIT_ESCROW",
      status: current.state.status,
      revision: current.state.revision,
      attemptCount: current.state.attemptCount,
      acceptedAt: current.state.acceptedAt,
      preparedAt: current.state.preparedAt,
      signedAt: current.state.signedAt,
      submittedAt: current.state.submittedAt,
      confirmedAt: current.state.confirmedAt,
      finalizedAt: current.state.finalizedAt,
      projectedAt: current.state.projectedAt,
      unknownSince: current.state.unknownSince,
      updatedAt: current.updatedAt,
    })),
  };
  const signed = {
    version: 1 as const,
    cluster: "localnet" as const,
    genesisHash: GENESIS,
    programAddress: PROGRAM as Address,
    participantAddress: PARTICIPANT,
    sponsorAddress: SPONSOR,
    signature: wireReference.transactionSignature,
    signedWireBase64: "wire" as never,
    messageSha256: "digest",
    recentBlockhash: SPONSOR,
    lastValidBlockHeight: 99n,
  };
  const dependencies = {
    store,
    env,
    owner: "worker",
    now: () => new Date("2026-09-20T00:00:01Z"),
    loadParticipant: vi.fn(async () => createNoopSigner(PARTICIPANT)),
    loadSponsor: vi.fn(async () => createNoopSigner(SPONSOR)),
    prepare: vi.fn(async () => ({
      signed,
      market: SPONSOR,
      seats: SPONSOR,
      vault: SPONSOR,
      walletTokens: SPONSOR,
      amount: 505n,
      expectedNonce: 0n,
      observedSlot: 1n,
      availableCash: 1_000n,
      walletTokenAmount: 1_000n,
    })),
    submit: vi.fn(async (input: { onPrepared: (receipt: typeof signed) => void }) => {
      events.push("SUBMIT");
      input.onPrepared(signed);
      return {
        status: "submitted" as const,
        signature: signed.signature,
        signedWireBase64: signed.signedWireBase64,
        lastValidBlockHeight: signed.lastValidBlockHeight,
      };
    }),
    track: vi.fn(async () => ({ status: "finalized" as const, signature: signed.signature })),
  };
  return { store, events, signed, dependencies };
}

describe("managed escrow deposit dispatcher", () => {
  it("journals exact signed bytes before one send and waits for finalization", async () => {
    const f = fixture();
    const result = await dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies);

    expect(f.events).toEqual(["PREPARED", "JOURNAL", "SUBMIT", "SUBMITTED", "FINALIZED"]);
    expect(result.status).toBe("FINALIZED");
    expect(f.dependencies.prepare).toHaveBeenCalledWith(expect.objectContaining({ marketId: 7n, amount: 505n }));
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledWith(expect.objectContaining({
      wire: expect.objectContaining({
        signedWireBase64: f.signed.signedWireBase64,
        transactionSignature: f.signed.signature,
        feePayerAddress: SPONSOR,
        signerAddresses: [SPONSOR, PARTICIPANT],
        sequence: 1,
      }),
    }));
    expect(f.dependencies.submit).toHaveBeenCalledOnce();
  });

  it.each(["SIGNED", "SUBMITTED"] as const)(
    "reconciles retained %s wire without preparing, signing, or submitting again",
    async status => {
      const f = fixture(status);
      const result = await dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies);

      expect(result.status).toBe("FINALIZED");
      expect(f.store.loadLatestWireReference).toHaveBeenCalledWith("command_12345678");
      expect(f.dependencies.track).toHaveBeenCalledWith(expect.objectContaining({
        signature: f.signed.signature,
        lastValidBlockHeight: 99n,
      }));
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
      expect(f.events).toEqual(status === "SIGNED" ? ["SUBMITTED", "FINALIZED"] : ["FINALIZED"]);
    },
  );

  it.each(["UNKNOWN", "FINALIZED", "PROJECTED", "FAILED_TERMINAL"] as const)(
    "does not lease or replace a %s command",
    async status => {
      const f = fixture(status);
      expect((await dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies)).status).toBe(status);
      expect(f.store.acquireLease).not.toHaveBeenCalled();
      expect(f.dependencies.prepare).not.toHaveBeenCalled();
      expect(f.dependencies.submit).not.toHaveBeenCalled();
    },
  );

  it("marks a post-journal throw UNKNOWN and never creates replacement bytes", async () => {
    const f = fixture();
    f.dependencies.submit.mockRejectedValueOnce(new Error("transport failed before a response"));

    await expect(dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies)).rejects.toThrow(/transport/);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
    expect(f.store.appendSignedWireBeforeSend).toHaveBeenCalledOnce();
    expect(f.dependencies.submit).toHaveBeenCalledOnce();
  });

  it("rejects submission if its prepared receipt differs from the durable wire", async () => {
    const f = fixture();
    f.dependencies.submit.mockImplementationOnce(async input => {
      input.onPrepared({ ...f.signed, signedWireBase64: "changed-wire" as never });
      return {
        status: "submitted",
        signature: f.signed.signature,
        signedWireBase64: f.signed.signedWireBase64,
        lastValidBlockHeight: 99n,
      };
    });

    await expect(dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies))
      .rejects.toThrow(/changed the journaled escrow transaction/);
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
    expect(f.dependencies.track).not.toHaveBeenCalled();
  });

  it("retains an ambiguous send as UNKNOWN without tracking or retrying", async () => {
    const f = fixture();
    f.dependencies.submit.mockResolvedValueOnce({
      status: "unknown",
      signature: f.signed.signature,
      signedWireBase64: f.signed.signedWireBase64,
      lastValidBlockHeight: 99n,
    } as never);

    expect((await dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies)).status).toBe("UNKNOWN");
    expect(f.events).toEqual(["PREPARED", "JOURNAL", "UNKNOWN"]);
    expect(f.dependencies.track).not.toHaveBeenCalled();
  });

  it("fails closed on custody drift before signing and remains retryable", async () => {
    const f = fixture();
    f.dependencies.loadParticipant.mockResolvedValueOnce(createNoopSigner(SPONSOR));

    await expect(dispatchManagedEscrowDepositCommand("command_12345678", f.dependencies)).rejects.toThrow(/wallet changed/);
    expect(f.events).toEqual(["PREPARED", "FAILED_RETRYABLE"]);
    expect(f.dependencies.prepare).not.toHaveBeenCalled();
    expect(f.store.appendSignedWireBeforeSend).not.toHaveBeenCalled();
  });

  it("classifies non-final tracking as UNKNOWN and finalized rejection as terminal", async () => {
    const uncertain = fixture();
    uncertain.dependencies.track.mockResolvedValueOnce({
      status: "expired",
      signature: uncertain.signed.signature,
      historicalOutcome: "unknown",
    } as never);
    expect((await dispatchManagedEscrowDepositCommand("command_12345678", uncertain.dependencies)).status).toBe("UNKNOWN");

    const rejected = fixture();
    rejected.dependencies.track.mockResolvedValueOnce({
      status: "failed",
      signature: rejected.signed.signature,
      commitment: "finalized",
      error: { InstructionError: [0, "Custom"] },
    } as never);
    expect((await dispatchManagedEscrowDepositCommand("command_12345678", rejected.dependencies)).status)
      .toBe("FAILED_TERMINAL");
    expect(rejected.store.transition).toHaveBeenLastCalledWith("command_12345678", expect.objectContaining({
      to: "FAILED_TERMINAL",
      errorCode: "ONCHAIN_ESCROW_DEPOSIT_REJECTED",
    }));
  });

  it("accepts/replays then dispatches active commands while preserving ambiguous replays", async () => {
    const dispatch = vi.fn(async () => ({ status: "FINALIZED" } as never));
    const accept = vi.fn(async () => ({
      accepted: true as const,
      pending: true as const,
      command: { id: "command_12345678", status: "ACCEPTED" } as never,
    }));
    const input = {
      userId: "user_12345678",
      marketSlug: "market-one",
      parentCommandId: "parent_command_12345678",
      amount: 505n,
    };

    expect(await ensureManagedEscrowDeposit(input, { accept, dispatch })).toEqual({ status: "FINALIZED" });
    expect(dispatch).toHaveBeenCalledWith("command_12345678", expect.objectContaining({ accept, dispatch }));

    dispatch.mockClear();
    accept.mockResolvedValueOnce({
      accepted: true,
      pending: true,
      command: { id: "command_12345678", status: "UNKNOWN" } as never,
    });
    expect((await ensureManagedEscrowDeposit(input, { accept, dispatch })).status).toBe("UNKNOWN");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
