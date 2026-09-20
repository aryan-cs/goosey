import { randomBytes } from "node:crypto";

import { address, createSolanaRpc } from "@solana/kit";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { ensureManagedFeatherAccountReady } from "@/lib/solana/managed-account-readiness";
import {
  acceptManagedFeatherTransfer,
  managedTransferCommandEnvelopeSchema,
} from "@/lib/solana/managed-transfer-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredFeatherTransfer } from "@/lib/solana/sponsored-feather-transfer";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition"
  | "appendSignedWireBeforeSend" | "publicStatus">;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  ensureProvisioned?: typeof ensureManagedFeatherAccountReady;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredFeatherTransfer;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{
    signature: string;
    lastValidBlockHeight: bigint;
    signal?: AbortSignal;
  }>) => Promise<TransactionStatusResult>;
  signal?: AbortSignal;
}>;

const DISPATCHABLE = new Set([
  "ACCEPTED",
  "PREPARED",
  "SIGNED",
  "SUBMITTED",
  "CONFIRMED",
  "UNKNOWN",
  "FAILED_RETRYABLE",
]);
const RETAINED_WIRE = new Set(["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"]);

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
    throw new Error("Sponsored submission changed the journaled feather transfer");
  }
}

function boundedFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Managed feather transfer dispatch failed";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Managed feather transfer dispatch failed";
}

/** Dispatches one managed transfer and never replaces an ambiguous signed wire. */
export async function dispatchManagedFeatherTransferCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-transfer-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "TRANSFER_FEATHERS" || command.identity.scope !== "USER"
    || command.identity.scopeId !== command.identity.actorId
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed transfer command does not match the pinned user deployment");
  }
  if (!DISPATCHABLE.has(command.state.status)) return store.publicStatus(commandId);

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
    if (RETAINED_WIRE.has(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (wire?.lastValidBlockHeight == null) {
        throw new Error("Pending managed transfer has no recent-blockhash wire journal");
      }
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(
        createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 },
      )))({ signature: wire.transactionSignature, lastValidBlockHeight: wire.lastValidBlockHeight,
        signal: dependencies.signal });
      if (tracked.status === "finalized") {
        if (command.state.status === "SIGNED") {
          command = await store.transition(commandId, {
            expectedRevision: command.state.revision, ...fence(), to: "SUBMITTED",
          });
        }
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "FINALIZED",
        });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_TRANSFER_REJECTED",
          errorMessage: "The finalized Solana token program rejected this feather transfer.",
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
    const envelope = managedTransferCommandEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
    const request = envelope.request;
    const readiness = await (dependencies.ensureProvisioned ?? ensureManagedFeatherAccountReady)({
      userId: command.identity.actorId,
      env,
      signal: dependencies.signal,
    });
    if (readiness.status !== "ready" || readiness.walletAddress !== request.senderWalletAddress) {
      throw new Error("Managed feather account is not ready for the frozen transfer wallet");
    }
    const [participant, sponsor] = await Promise.all([
      (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(command.identity.actorId, env),
      (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
    ]);
    if (participant.address !== request.senderWalletAddress || sponsor.address !== request.sponsorAddress) {
      throw new Error("Managed transfer signer changed after command acceptance");
    }
    const amount = BigInt(request.amount);
    const prepared = await (dependencies.prepare ?? prepareSponsoredFeatherTransfer)({
      runtime,
      participant,
      sponsor,
      recipient: address(request.recipientWalletAddress),
      amount,
      signal: dependencies.signal,
    });
    if (prepared.amount !== amount || prepared.sender !== request.senderWalletAddress
      || prepared.recipient !== request.recipientWalletAddress
      || prepared.signed.participantAddress !== request.senderWalletAddress
      || prepared.signed.sponsorAddress !== request.sponsorAddress) {
      throw new Error("Prepared feather transfer does not match the frozen command");
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
    )))({ signature: submission.signature, lastValidBlockHeight: submission.lastValidBlockHeight,
      signal: dependencies.signal });
    if (tracked.status === "finalized") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FINALIZED",
      });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_TRANSFER_REJECTED",
        errorMessage: "The finalized Solana token program rejected this feather transfer.",
      });
    } else {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
      });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (RETAINED_WIRE.has(command.state.status) && command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "FAILED_RETRYABLE",
          errorCode: "TRANSFER_DISPATCH_FAILED",
          errorMessage: boundedFailure(error),
        });
      }
    } catch {
      // A stale lease fence means another worker owns authoritative state.
    }
    throw error;
  }
}

/** Accepts/replays an immutable transfer and immediately advances its command. */
export async function ensureManagedFeatherTransfer(input: Readonly<{
  senderUserId: string;
  idempotencyKey: string;
  request: unknown;
}>, dependencies: Dependencies & Readonly<{
  accept?: typeof acceptManagedFeatherTransfer;
  dispatch?: typeof dispatchManagedFeatherTransferCommand;
}> = {}): Promise<PublicChainCommandStatus> {
  const accepted = await (dependencies.accept ?? acceptManagedFeatherTransfer)(input, {
    database: dependencies.database as never,
    env: dependencies.env,
  });
  if (!DISPATCHABLE.has(accepted.command.status)) return accepted.command;
  return (dependencies.dispatch ?? dispatchManagedFeatherTransferCommand)(accepted.command.id, dependencies);
}
