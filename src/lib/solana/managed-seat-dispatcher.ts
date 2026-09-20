import { randomBytes } from "node:crypto";

import { createSolanaRpc } from "@solana/kit";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { ensureManagedFeatherAccountReady } from "@/lib/solana/managed-account-readiness";
import { acceptManagedSeatRegistration, managedSeatCommandEnvelopeSchema } from "@/lib/solana/managed-seat-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredSeatRegistration } from "@/lib/solana/sponsored-seat";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  ensureProvisioned?: typeof ensureManagedFeatherAccountReady;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredSeatRegistration;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{
    signature: string;
    lastValidBlockHeight: bigint;
    signal?: AbortSignal;
  }>) => Promise<TransactionStatusResult>;
  signal?: AbortSignal;
}>;

const RETRYABLE_STARTS = new Set(["ACCEPTED", "PREPARED", "FAILED_RETRYABLE"]);
const UNCERTAIN_AFTER_WIRE = new Set(["SIGNED", "SUBMITTED", "CONFIRMED"]);

function exactPreparedReceipt(expected: Readonly<{
  signature: string;
  signedWireBase64: string;
  lastValidBlockHeight: bigint;
}>, actual: Readonly<{
  signature: string;
  signedWireBase64: string;
  lastValidBlockHeight: bigint;
}>): void {
  if (actual.signature !== expected.signature || actual.signedWireBase64 !== expected.signedWireBase64
    || actual.lastValidBlockHeight !== expected.lastValidBlockHeight) {
    throw new Error("Sponsored submission changed the journaled seat transaction");
  }
}

/**
 * Executes at most one freshly signed seat transaction under a five-minute CAS
 * lease. Once wire bytes are durable, every error becomes UNKNOWN; this worker
 * never replaces or re-signs an ambiguous transaction.
 */
export async function dispatchManagedSeatRegistrationCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-seat-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "REGISTER_SEAT" || command.identity.scope !== "USER"
    || command.identity.scopeId !== command.identity.actorId
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed seat command does not match the pinned user deployment");
  }
  if (!RETRYABLE_STARTS.has(command.state.status) && !UNCERTAIN_AFTER_WIRE.has(command.state.status)) {
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
    if (UNCERTAIN_AFTER_WIRE.has(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) {
        throw new Error("Pending managed seat registration has no recent-blockhash wire journal");
      }
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(
        createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 },
      )))({ signature: wire.transactionSignature, lastValidBlockHeight: wire.lastValidBlockHeight,
        signal: dependencies.signal });
      if (tracked.status === "finalized") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "FINALIZED",
        });
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "PROJECTED",
        });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_SEAT_REJECTED",
          errorMessage: "The finalized Goosey program rejected this seat registration.",
        });
      } else {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      }
      return store.publicStatus(commandId);
    }
    if (command.state.status === "FAILED_RETRYABLE") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "ACCEPTED",
      });
    }
    if (command.state.status === "ACCEPTED") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "PREPARED",
      });
    }

    const envelope = managedSeatCommandEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
    const readiness = await (dependencies.ensureProvisioned ?? ensureManagedFeatherAccountReady)({
      userId: command.identity.actorId,
      env,
      signal: dependencies.signal,
    });
    if (readiness.status !== "ready" || readiness.walletAddress !== envelope.request.walletAddress) {
      throw new Error("Managed feather account is not ready for the frozen seat wallet");
    }
    const [participant, sponsor] = await Promise.all([
      (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(command.identity.actorId, env),
      (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
    ]);
    if (participant.address !== envelope.request.walletAddress) {
      throw new Error("Managed seat custody wallet changed after command acceptance");
    }
    const prepared = await (dependencies.prepare ?? prepareSponsoredSeatRegistration)({
      runtime,
      participant,
      sponsor,
      marketId: BigInt(envelope.request.chainMarketId),
      signal: dependencies.signal,
    });
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
    const journaled = await store.appendSignedWireBeforeSend({ wire, ...fence() });
    command = journaled.command;

    const submission = await (dependencies.submit ?? submitSponsoredTransaction)({
      runtime,
      signed: prepared.signed,
      signal: dependencies.signal,
      onPrepared: receipt => exactPreparedReceipt(prepared.signed, receipt),
    });
    command = await store.transition(commandId, {
      expectedRevision: command.state.revision,
      ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN",
    });
    if (submission.status === "unknown") return store.publicStatus(commandId);

    const tracked = await (dependencies.track ?? (value => trackTransactionStatus(
      createSolanaRpc(runtime.rpcUrl),
      { ...value, commitment: "finalized", timeoutMs: 45_000 },
    )))({
      signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight,
      signal: dependencies.signal,
    });
    if (tracked.status === "finalized") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FINALIZED",
      });
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "PROJECTED",
      });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_SEAT_REJECTED",
        errorMessage: "The finalized Goosey program rejected this seat registration.",
      });
    } else {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
      });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (UNCERTAIN_AFTER_WIRE.has(command.state.status)) {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "FAILED_RETRYABLE",
          errorCode: "SEAT_DISPATCH_FAILED",
          errorMessage: "Managed seat registration could not be completed safely.",
        });
      }
    } catch {
      // A stale fence means another worker owns the authoritative state.
    }
    throw error;
  }
}

/** Accepts/replays and immediately advances the bounded background command. */
export async function ensureManagedSeatRegistration(input: Readonly<{
  userId: string;
  marketSlug: string;
}>, dependencies: Dependencies & Readonly<{
  accept?: typeof acceptManagedSeatRegistration;
  dispatch?: typeof dispatchManagedSeatRegistrationCommand;
}> = {}): Promise<PublicChainCommandStatus> {
  const accepted = await (dependencies.accept ?? acceptManagedSeatRegistration)(input, {
    database: dependencies.database as never,
    env: dependencies.env,
  });
  if (!["ACCEPTED", "PREPARED", "FAILED_RETRYABLE"].includes(accepted.command.status)) return accepted.command;
  return (dependencies.dispatch ?? dispatchManagedSeatRegistrationCommand)(accepted.command.id, dependencies);
}
