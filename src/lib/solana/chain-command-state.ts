import { createHash } from "node:crypto";

import type { ChainCommandStatus } from "@/lib/solana/chain-command";
import { ChainCommandValidationError } from "@/lib/solana/chain-command";

const MAX_REVISION = 2_147_483_647;
const ACTIVE_STATUSES = new Set<ChainCommandStatus>(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FINALIZED", "UNKNOWN", "FAILED_RETRYABLE"]);
const TRANSITIONS: Readonly<Record<ChainCommandStatus, readonly ChainCommandStatus[]>> = {
  ACCEPTED: ["PREPARED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  PREPARED: ["SIGNED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  SIGNED: ["SUBMITTED", "UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  SUBMITTED: ["CONFIRMED", "FINALIZED", "UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  CONFIRMED: ["FINALIZED", "UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  FINALIZED: ["PROJECTED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  PROJECTED: [],
  UNKNOWN: ["SUBMITTED", "CONFIRMED", "FINALIZED", "FAILED_RETRYABLE", "FAILED_TERMINAL"],
  FAILED_RETRYABLE: ["ACCEPTED", "UNKNOWN", "FAILED_TERMINAL"],
  FAILED_TERMINAL: [],
};

export type ChainCommandLease = Readonly<{
  owner: string;
  tokenHash: string;
  epoch: number;
  expiresAt: Date;
}>;

export type ChainCommandState = Readonly<{
  id: string;
  status: ChainCommandStatus;
  revision: number;
  attemptCount: number;
  leaseEpoch: number;
  lease: ChainCommandLease | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  acceptedAt: Date;
  preparedAt: Date | null;
  signedAt: Date | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  finalizedAt: Date | null;
  projectedAt: Date | null;
  unknownSince: Date | null;
}>;

export type ChainCommandCasPlan = Readonly<{
  commandId: string;
  expectedRevision: number;
  expectedLease: ChainCommandLease | null;
  next: ChainCommandState;
}>;

export class ChainCommandConflictError extends Error {
  constructor(message = "Chain command compare-and-swap conflict") {
    super(message);
    this.name = "ChainCommandConflictError";
  }
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(value)) {
    throw new ChainCommandValidationError(`Invalid ${label}`);
  }
  return value;
}

function assertRevision(state: ChainCommandState, expectedRevision: number): void {
  if (state.revision !== expectedRevision) throw new ChainCommandConflictError();
  if (state.revision < 0 || state.revision >= MAX_REVISION) throw new ChainCommandConflictError("Chain command revision exhausted");
}

function nextRevision(state: ChainCommandState): number {
  if (state.revision >= MAX_REVISION) throw new ChainCommandConflictError("Chain command revision exhausted");
  return state.revision + 1;
}

export function hashChainCommandLeaseToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new ChainCommandValidationError("Invalid lease token");
  return createHash("sha256").update(token).digest("hex");
}

export function acquireChainCommandLease(state: ChainCommandState, input: Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  now: Date;
  expiresAt: Date;
}>): ChainCommandCasPlan {
  assertRevision(state, input.expectedRevision);
  if (!ACTIVE_STATUSES.has(state.status) || state.status === "PROJECTED" || state.status === "FAILED_TERMINAL") {
    throw new ChainCommandConflictError("Terminal chain command cannot be leased");
  }
  if (!(input.now instanceof Date) || !(input.expiresAt instanceof Date)
    || !Number.isFinite(input.now.getTime()) || !Number.isFinite(input.expiresAt.getTime())
    || input.expiresAt.getTime() <= input.now.getTime()
    || input.expiresAt.getTime() - input.now.getTime() > 5 * 60_000) {
    throw new ChainCommandValidationError("Lease duration must be greater than zero and at most five minutes");
  }
  if (state.lease && state.lease.expiresAt.getTime() > input.now.getTime()) {
    throw new ChainCommandConflictError("Chain command already has an active lease");
  }
  if (state.leaseEpoch < 0 || state.leaseEpoch >= MAX_REVISION) throw new ChainCommandConflictError("Lease epoch exhausted");
  const lease = {
    owner: identifier(input.owner, "lease owner"),
    tokenHash: hashChainCommandLeaseToken(input.token),
    epoch: state.leaseEpoch + 1,
    expiresAt: new Date(input.expiresAt),
  };
  return {
    commandId: state.id,
    expectedRevision: state.revision,
    expectedLease: state.lease,
    next: { ...state, revision: nextRevision(state), attemptCount: state.attemptCount + 1, leaseEpoch: lease.epoch, lease },
  };
}

function assertFence(state: ChainCommandState, input: Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  epoch: number;
  now: Date;
}>): ChainCommandLease {
  assertRevision(state, input.expectedRevision);
  const lease = state.lease;
  if (!lease || lease.owner !== input.owner || lease.tokenHash !== hashChainCommandLeaseToken(input.token)
    || lease.epoch !== input.epoch || lease.expiresAt.getTime() <= input.now.getTime()) {
    throw new ChainCommandConflictError("Stale or expired chain command lease fence");
  }
  return lease;
}

export function renewChainCommandLease(state: ChainCommandState, input: Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  epoch: number;
  now: Date;
  expiresAt: Date;
}>): ChainCommandCasPlan {
  const lease = assertFence(state, input);
  if (input.expiresAt.getTime() <= input.now.getTime() || input.expiresAt.getTime() - input.now.getTime() > 5 * 60_000) {
    throw new ChainCommandValidationError("Lease duration must be greater than zero and at most five minutes");
  }
  return {
    commandId: state.id,
    expectedRevision: state.revision,
    expectedLease: lease,
    next: { ...state, revision: nextRevision(state), lease: { ...lease, expiresAt: new Date(input.expiresAt) } },
  };
}

export function transitionChainCommand(state: ChainCommandState, input: Readonly<{
  expectedRevision: number;
  owner: string;
  token: string;
  epoch: number;
  now: Date;
  to: ChainCommandStatus;
  errorCode?: string;
  errorMessage?: string;
}>): ChainCommandCasPlan {
  const lease = assertFence(state, input);
  if (!TRANSITIONS[state.status].includes(input.to)) {
    throw new ChainCommandConflictError(`Illegal chain command transition ${state.status} -> ${input.to}`);
  }
  const failed = input.to === "FAILED_RETRYABLE" || input.to === "FAILED_TERMINAL";
  if (failed !== Boolean(input.errorCode && input.errorMessage)) {
    throw new ChainCommandValidationError("Failure transitions require exactly one bounded error code and message pair");
  }
  if (input.errorCode && (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.errorCode) || Buffer.byteLength(input.errorMessage ?? "") > 1_000)) {
    throw new ChainCommandValidationError("Invalid bounded chain command error");
  }
  const timestamp = new Date(input.now);
  const next: ChainCommandState = {
    ...state,
    status: input.to,
    revision: nextRevision(state),
    lease: ["PROJECTED", "UNKNOWN", "FAILED_RETRYABLE", "FAILED_TERMINAL"].includes(input.to) ? null : lease,
    lastErrorCode: failed ? input.errorCode! : null,
    lastErrorMessage: failed ? input.errorMessage! : null,
    preparedAt: input.to === "PREPARED" ? timestamp : state.preparedAt,
    signedAt: input.to === "SIGNED" ? timestamp : state.signedAt,
    submittedAt: input.to === "SUBMITTED" ? timestamp : state.submittedAt,
    confirmedAt: input.to === "CONFIRMED" ? timestamp : state.confirmedAt,
    finalizedAt: input.to === "FINALIZED" ? timestamp : state.finalizedAt,
    projectedAt: input.to === "PROJECTED" ? timestamp : state.projectedAt,
    unknownSince: input.to === "UNKNOWN" ? timestamp : input.to === "ACCEPTED" ? null : state.unknownSince,
  };
  return { commandId: state.id, expectedRevision: state.revision, expectedLease: lease, next };
}

/** Verifies that a database row still matches every CAS and lease-fence predicate. */
export function assertChainCommandCasApplied(plan: ChainCommandCasPlan, persisted: ChainCommandState): void {
  if (persisted.id !== plan.commandId || persisted.revision !== plan.next.revision
    || persisted.status !== plan.next.status || persisted.leaseEpoch !== plan.next.leaseEpoch
    || persisted.lease?.epoch !== plan.next.lease?.epoch
    || persisted.lease?.tokenHash !== plan.next.lease?.tokenHash) {
    throw new ChainCommandConflictError("Chain command CAS was not applied exactly once");
  }
}
