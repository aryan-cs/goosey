import { randomBytes } from "node:crypto";

import { createSolanaRpc } from "@solana/kit";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import {
  acceptManagedEscrowDeposit,
  managedEscrowCommandEnvelopeSchema,
} from "@/lib/solana/managed-escrow-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredEscrowDeposit } from "@/lib/solana/sponsored-escrow";
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
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredEscrowDeposit;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{
    signature: string;
    lastValidBlockHeight: bigint;
    signal?: AbortSignal;
  }>) => Promise<TransactionStatusResult>;
  signal?: AbortSignal;
}>;

const DISPATCHABLE = new Set(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED_RETRYABLE"]);
const RETAINED_WIRE = new Set(["SIGNED", "SUBMITTED", "CONFIRMED"]);

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
    throw new Error("Sponsored submission changed the journaled escrow transaction");
  }
}

function boundedFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Managed escrow deposit dispatch failed";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Managed escrow deposit dispatch failed";
}

/**
 * Dispatches one accepted managed escrow deposit under a fenced lease. Signed
 * bytes are durable before the first send. Once a wire journal exists, this
 * worker only reconciles its retained signature and never signs a replacement.
 */
export async function dispatchManagedEscrowDepositCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-escrow-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);

  if (command.identity.operation !== "DEPOSIT_ESCROW" || command.identity.scope !== "USER"
    || command.identity.scopeId !== command.identity.actorId
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed escrow command does not match the pinned user deployment");
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
        throw new Error("Pending managed escrow deposit has no recent-blockhash wire journal");
      }
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(
        createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 },
      )))({
        signature: wire.transactionSignature,
        lastValidBlockHeight: wire.lastValidBlockHeight,
        signal: dependencies.signal,
      });
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
          errorCode: "ONCHAIN_ESCROW_DEPOSIT_REJECTED",
          errorMessage: "The finalized Goosey program rejected this escrow deposit.",
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

    const envelope = managedEscrowCommandEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
    const request = envelope.request;
    const [participant, sponsor] = await Promise.all([
      (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(command.identity.actorId, env),
      (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
    ]);
    if (participant.address !== request.walletAddress) {
      throw new Error("Managed escrow custody wallet changed after command acceptance");
    }

    const amount = BigInt(request.amount);
    const prepared = await (dependencies.prepare ?? prepareSponsoredEscrowDeposit)({
      runtime,
      participant,
      sponsor,
      marketId: BigInt(request.chainMarketId),
      amount,
      signal: dependencies.signal,
    });
    if (prepared.amount !== amount || prepared.signed.participantAddress !== request.walletAddress
      || prepared.signed.sponsorAddress !== sponsor.address) {
      throw new Error("Prepared escrow deposit does not match the frozen command");
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
    )))({
      signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight,
      signal: dependencies.signal,
    });
    if (tracked.status === "finalized") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FINALIZED",
      });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_ESCROW_DEPOSIT_REJECTED",
        errorMessage: "The finalized Goosey program rejected this escrow deposit.",
      });
    } else {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
      });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (RETAINED_WIRE.has(command.state.status)) {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "FAILED_RETRYABLE",
          errorCode: "ESCROW_DEPOSIT_DISPATCH_FAILED",
          errorMessage: boundedFailure(error),
        });
      }
    } catch {
      // A stale fence means another worker owns the authoritative state.
    }
    throw error;
  }
}

/** Accepts/replays an immutable deposit intent and advances its command. */
export async function ensureManagedEscrowDeposit(input: Readonly<{
  userId: string;
  marketSlug: string;
  parentCommandId: string;
  amount: bigint;
}>, dependencies: Dependencies & Readonly<{
  accept?: typeof acceptManagedEscrowDeposit;
  dispatch?: typeof dispatchManagedEscrowDepositCommand;
}> = {}): Promise<PublicChainCommandStatus> {
  const accepted = await (dependencies.accept ?? acceptManagedEscrowDeposit)(input, {
    database: dependencies.database as never,
    env: dependencies.env,
  });
  if (!DISPATCHABLE.has(accepted.command.status)) return accepted.command;
  return (dependencies.dispatch ?? dispatchManagedEscrowDepositCommand)(accepted.command.id, dependencies);
}
