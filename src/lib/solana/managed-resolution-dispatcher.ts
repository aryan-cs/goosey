import { randomBytes } from "node:crypto";

import { createSolanaRpc, type Address } from "@solana/kit";

import { db } from "@/lib/db";
import type { TransactionRunner } from "@/lib/serializable-transaction";
import type { SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { managedResolutionCommandEnvelopeSchema } from "@/lib/solana/managed-resolution-service";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import {
  prepareSponsoredResolution,
  type ManagedResolutionFingerprint,
  type ManagedResolutionOperation,
} from "@/lib/solana/sponsored-resolution";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

const OPERATIONS = new Set<ManagedResolutionOperation>([
  "CLOSE_RESOLUTION",
  "PROPOSE_RESOLUTION",
  "APPROVE_RESOLUTION",
  "CLAIM_RESOLUTION",
  "FINALIZE_RESOLUTION",
]);
const RECOVERABLE_WIRE_STATUSES = new Set(["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"]);

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;
type Prepared = Awaited<ReturnType<typeof prepareSponsoredResolution>>;
type Envelope = ReturnType<typeof managedResolutionCommandEnvelopeSchema.parse>;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredResolution;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  verifyFinalized?: typeof verifyFinalizedManagedResolution;
  signal?: AbortSignal;
}>;

function fingerprint(envelope: Envelope): ManagedResolutionFingerprint | undefined {
  if (envelope.operation !== "PROPOSE_RESOLUTION" && envelope.operation !== "APPROVE_RESOLUTION") return undefined;
  return Object.freeze({
    sequence: BigInt(envelope.request.sequence),
    outcome: envelope.request.outcome,
    reasonDigestSha256: Uint8Array.from(Buffer.from(envelope.request.reasonDigestSha256, "hex")),
    evidenceDigestSha256: Uint8Array.from(Buffer.from(envelope.request.evidenceDigestSha256, "hex")),
  });
}

function expectedOutcome(value: "YES" | "NO" | "VOID"): 0 | 1 | 2 {
  return value === "YES" ? 0 : value === "NO" ? 1 : 2;
}

/** Re-reads a coherent finalized state at or after the exact signature's slot. */
export async function verifyFinalizedManagedResolution(input: Readonly<{
  runtime: SolanaRuntime;
  participantAddress: Address;
  operation: ManagedResolutionOperation;
  marketId: bigint;
  minimumFinalizedSlot: bigint;
  fingerprint?: ManagedResolutionFingerprint;
  signal?: AbortSignal;
}>): Promise<Readonly<{ finalizedSlot: bigint; phase: number }>> {
  const snapshot = await readGooseyEscrow(input.runtime, {
    marketId: input.marketId,
    wallet: input.participantAddress,
  }, {
    signal: input.signal,
    includeOrderBook: true,
    includeResolution: true,
    includeMarketTerms: true,
    minimumFinalizedSlot: input.minimumFinalizedSlot,
  });
  const resolution = snapshot.resolution;
  if (!resolution || snapshot.marketState.marketId !== input.marketId
    || snapshot.wallet !== input.participantAddress || snapshot.finalizedSlot < input.minimumFinalizedSlot
    || resolution.market !== snapshot.market || !snapshot.orderBook?.reservesReconciled) {
    throw new Error("Finalized managed resolution snapshot is incomplete or mismatched");
  }
  if (input.operation === "CLOSE_RESOLUTION" && resolution.phase < 1) {
    throw new Error("Finalized close is not reflected on chain");
  }
  if (input.operation === "PROPOSE_RESOLUTION") {
    const expected = input.fingerprint;
    // A later approval or rejection may already have moved the phase again. The
    // immutable exact signature proves which fingerprint landed; sequence
    // advancement proves that landing is represented by this newer snapshot.
    if (!expected || resolution.nextProposalSequence <= expected.sequence) {
      throw new Error("Finalized proposal is not reflected by the resolution state");
    }
  }
  if (input.operation === "APPROVE_RESOLUTION") {
    const expected = input.fingerprint;
    if (!expected || resolution.phase < 3 || resolution.outcome !== expectedOutcome(expected.outcome)) {
      throw new Error("Finalized approval outcome is not reflected on chain");
    }
  }
  if (input.operation === "CLAIM_RESOLUTION") {
    if (!snapshot.registered || !snapshot.seat || snapshot.seat.yes !== 0n || snapshot.seat.no !== 0n) {
      throw new Error("Finalized claim has not cleared the participant position");
    }
  }
  if (input.operation === "FINALIZE_RESOLUTION" && resolution.phase !== 4) {
    throw new Error("Finalized resolution finalization is not reflected on chain");
  }
  return Object.freeze({ finalizedSlot: snapshot.finalizedSlot, phase: resolution.phase });
}

function exactSubmission(prepared: Prepared, submission: Awaited<ReturnType<typeof submitSponsoredTransaction>>): void {
  if (submission.signature !== prepared.signed.signature
    || submission.lastValidBlockHeight !== prepared.signed.lastValidBlockHeight
    || submission.signedWireBase64 !== prepared.signed.signedWireBase64) {
    throw new Error("Managed resolution submission differs from the journaled signed transaction");
  }
}

/**
 * Advances one immutable resolution command. Exact signed bytes are append-only
 * before send; retained wires are reconciled and ambiguous wires are never replaced.
 */
export async function dispatchManagedResolutionCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-resolution-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (!OPERATIONS.has(command.identity.operation as ManagedResolutionOperation)
    || command.identity.cluster !== runtime.cluster
    || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed resolution command does not match the pinned deployment");
  }
  if (["FINALIZED", "PROJECTED", "FAILED_TERMINAL"].includes(command.state.status)) {
    return store.publicStatus(commandId);
  }
  if (!["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN", "FAILED_RETRYABLE"].includes(command.state.status)) {
    return store.publicStatus(commandId);
  }

  const startedAt = now();
  command = await store.acquireLease(commandId, {
    expectedRevision: command.state.revision,
    owner,
    token,
    now: startedAt,
    expiresAt: new Date(startedAt.getTime() + 5 * 60_000),
  });
  const fence = () => ({ owner, token, epoch: command.state.leaseEpoch, now: now() });
  try {
    const envelope = managedResolutionCommandEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
    if (envelope.operation !== command.identity.operation) throw new Error("Managed resolution envelope operation changed");
    const operation = envelope.operation;
    const requestFingerprint = fingerprint(envelope);
    const participant = await (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(
      command.identity.actorId,
      env,
      dependencies.database as never,
    );
    const verify = async (executionSlot: bigint) => (dependencies.verifyFinalized ?? verifyFinalizedManagedResolution)({
      runtime,
      participantAddress: participant.address,
      operation,
      marketId: BigInt(envelope.request.chainMarketId),
      minimumFinalizedSlot: executionSlot,
      fingerprint: requestFingerprint,
      signal: dependencies.signal,
    });
    const track = dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), {
      ...value,
      commitment: "finalized",
      timeoutMs: 45_000,
    }));

    if (RECOVERABLE_WIRE_STATUSES.has(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) throw new Error("Pending managed resolution has no recent-blockhash wire journal");
      const tracked = await track({ signature: wire.transactionSignature,
        lastValidBlockHeight: wire.lastValidBlockHeight, signal: dependencies.signal });
      if (tracked.signature !== wire.transactionSignature) throw new Error("Resolution reconciliation returned a different signature");
      if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
        await verify(tracked.executionSlot);
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
          to: "FAILED_TERMINAL", errorCode: "ONCHAIN_RESOLUTION_REJECTED",
          errorMessage: "The finalized Goosey program rejected this resolution command." });
      } else if (command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      }
      return store.publicStatus(commandId);
    }

    if (command.state.status === "FAILED_RETRYABLE") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "ACCEPTED" });
    }
    if (command.state.status === "ACCEPTED") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PREPARED" });
    }
    const sponsor = await (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env);
    const prepared = await (dependencies.prepare ?? prepareSponsoredResolution)({
      runtime,
      participant,
      sponsor,
      marketId: BigInt(envelope.request.chainMarketId),
      operation,
      fingerprint: requestFingerprint,
      signal: dependencies.signal,
    });
    if (prepared.operation !== operation || prepared.signed.participantAddress !== participant.address
      || prepared.signed.sponsorAddress !== sponsor.address) {
      throw new Error("Prepared managed resolution bindings changed");
    }
    const wire: SignedWireInput = {
      commandId,
      sequence: command.state.attemptCount,
      leaseEpoch: command.state.leaseEpoch,
      commandRevision: command.state.revision,
      signedWireBase64: prepared.signed.signedWireBase64,
      transactionSignature: prepared.signed.signature,
      recentBlockhash: prepared.signed.recentBlockhash,
      lastValidBlockHeight: prepared.signed.lastValidBlockHeight,
      durableNonceAddress: null,
      feePayerAddress: prepared.signed.sponsorAddress,
      signerAddresses: [prepared.signed.sponsorAddress, prepared.signed.participantAddress],
    };
    command = (await store.appendSignedWireBeforeSend({ wire, ...fence() })).command;
    const submission = await (dependencies.submit ?? submitSponsoredTransaction)({
      runtime,
      signed: prepared.signed,
      onPrepared: receipt => exactSubmission(prepared, { ...receipt, status: "submitted" }),
      signal: dependencies.signal,
    });
    exactSubmission(prepared, submission);
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN" });
    if (submission.status === "unknown") return store.publicStatus(commandId);

    const tracked = await track({ signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight, signal: dependencies.signal });
    if (tracked.signature !== submission.signature) throw new Error("Resolution reconciliation returned a different signature");
    if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
      await verify(tracked.executionSlot);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
        to: "FAILED_TERMINAL", errorCode: "ONCHAIN_RESOLUTION_REJECTED",
        errorMessage: "The finalized Goosey program rejected this resolution command." });
    } else {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "FINALIZED", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
          to: "FAILED_RETRYABLE", errorCode: "RESOLUTION_DISPATCH_FAILED",
          errorMessage: "Managed resolution could not be completed safely." });
      }
    } catch {
      // A stale fence means another worker owns the authoritative state.
    }
    throw error;
  }
}
