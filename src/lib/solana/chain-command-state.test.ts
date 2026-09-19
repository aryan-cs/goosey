import { describe, expect, it } from "vitest";

import {
  acquireChainCommandLease,
  assertChainCommandCasApplied,
  ChainCommandConflictError,
  hashChainCommandLeaseToken,
  renewChainCommandLease,
  transitionChainCommand,
  type ChainCommandState,
} from "@/lib/solana/chain-command-state";

const token = "lease_token_abcdefghijklmnopqrstuvwxyz0123456789";
const now = new Date("2026-09-19T20:00:00.000Z");
const later = (milliseconds: number) => new Date(now.getTime() + milliseconds);

function accepted(): ChainCommandState {
  return {
    id: "command_12345678",
    status: "ACCEPTED",
    revision: 0,
    attemptCount: 0,
    leaseEpoch: 0,
    lease: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    acceptedAt: now,
    preparedAt: null,
    signedAt: null,
    submittedAt: null,
    confirmedAt: null,
    finalizedAt: null,
    projectedAt: null,
    unknownSince: null,
  };
}

function lease(state = accepted()) {
  return acquireChainCommandLease(state, {
    expectedRevision: state.revision,
    owner: "worker_12345678",
    token,
    now,
    expiresAt: later(60_000),
  }).next;
}

function advance(state: ChainCommandState, to: Parameters<typeof transitionChainCommand>[1]["to"], at: Date) {
  return transitionChainCommand(state, {
    expectedRevision: state.revision,
    owner: "worker_12345678",
    token,
    epoch: state.leaseEpoch,
    now: at,
    to,
  }).next;
}

describe("chain command lease fencing", () => {
  it("increments both CAS revision and durable lease epoch", () => {
    const plan = acquireChainCommandLease(accepted(), {
      expectedRevision: 0,
      owner: "worker_12345678",
      token,
      now,
      expiresAt: later(60_000),
    });
    expect(plan.next).toMatchObject({ revision: 1, attemptCount: 1, leaseEpoch: 1,
      lease: { owner: "worker_12345678", epoch: 1, tokenHash: hashChainCommandLeaseToken(token) } });
    expect(() => assertChainCommandCasApplied(plan, plan.next)).not.toThrow();
  });

  it("rejects active lease theft, stale revisions, wrong tokens, and expired leases", () => {
    const state = lease();
    expect(() => acquireChainCommandLease(state, {
      expectedRevision: state.revision, owner: "other_worker", token: `${token}x`, now: later(1), expiresAt: later(20_000),
    })).toThrow(/active lease/);
    expect(() => renewChainCommandLease(state, {
      expectedRevision: 0, owner: "worker_12345678", token, epoch: 1, now: later(1), expiresAt: later(20_000),
    })).toThrow(ChainCommandConflictError);
    expect(() => transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token: `${token}x`, epoch: 1, now: later(1), to: "PREPARED",
    })).toThrow(/fence/);
    expect(() => transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token, epoch: 1, now: later(60_000), to: "PREPARED",
    })).toThrow(/fence/);
  });

  it("preserves the fencing epoch after release and advances it on reacquisition", () => {
    let state = lease();
    state = transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token, epoch: 1, now: later(1),
      to: "FAILED_RETRYABLE", errorCode: "RPC_TIMEOUT", errorMessage: "Finality was not observed before the deadline.",
    }).next;
    expect(state).toMatchObject({ lease: null, leaseEpoch: 1, status: "FAILED_RETRYABLE" });
    const next = acquireChainCommandLease(state, {
      expectedRevision: state.revision, owner: "worker_2", token: `${token}x`, now: later(2), expiresAt: later(30_000),
    }).next;
    expect(next.leaseEpoch).toBe(2);
  });
});

describe("chain command lifecycle", () => {
  it("advances ACCEPTED through PROJECTED with one fenced CAS per transition", () => {
    let state = lease();
    for (const [status, at] of [
      ["PREPARED", later(1)], ["SIGNED", later(2)], ["SUBMITTED", later(3)],
      ["CONFIRMED", later(4)], ["FINALIZED", later(5)], ["PROJECTED", later(6)],
    ] as const) state = advance(state, status, at);
    expect(state).toMatchObject({ status: "PROJECTED", revision: 7, lease: null, leaseEpoch: 1,
      preparedAt: later(1), signedAt: later(2), submittedAt: later(3), confirmedAt: later(4),
      finalizedAt: later(5), projectedAt: later(6) });
    expect(() => acquireChainCommandLease(state, {
      expectedRevision: state.revision, owner: "worker", token, now: later(7), expiresAt: later(20_000),
    })).toThrow(/Terminal/);
  });

  it("makes UNKNOWN explicit and requires a fresh lease before reconciliation", () => {
    let state = lease();
    state = advance(advance(state, "PREPARED", later(1)), "SIGNED", later(2));
    state = transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token, epoch: 1, now: later(3), to: "UNKNOWN",
    }).next;
    expect(state).toMatchObject({ status: "UNKNOWN", lease: null, unknownSince: later(3) });
    const reconcilerToken = `${token}x`;
    state = acquireChainCommandLease(state, {
      expectedRevision: state.revision, owner: "reconciler", token: reconcilerToken, now: later(4), expiresAt: later(30_000),
    }).next;
    const reconciled = transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "reconciler", token: reconcilerToken,
      epoch: state.leaseEpoch, now: later(5), to: "FINALIZED",
    }).next;
    expect(reconciled.status).toBe("FINALIZED");
  });

  it("rejects skipped states and requires bounded failure diagnostics", () => {
    const state = lease();
    expect(() => advance(state, "FINALIZED", later(1))).toThrow(/Illegal/);
    expect(() => transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token, epoch: 1, now: later(1), to: "FAILED_RETRYABLE",
    })).toThrow(/error code/);
    expect(() => transitionChainCommand(state, {
      expectedRevision: state.revision, owner: "worker_12345678", token, epoch: 1, now: later(1),
      to: "FAILED_RETRYABLE", errorCode: "bad-code", errorMessage: "no",
    })).toThrow(/bounded/);
  });
});
