import { randomBytes } from "node:crypto";

import { createSolanaRpc, type Address } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { PrismaChainMutationLaneStore, type ChainMutationLane } from "@/lib/solana/chain-mutation-lane";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredCancellation } from "@/lib/solana/sponsored-cancellation";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

const U64_MAX = (1n << 64n) - 1n;
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= U64_MAX);
const envelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("CANCEL_ORDER"),
  request: z.object({
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: u64,
    orderId: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= U64_MAX),
    expectedVersion: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict();

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;
type MutationLaneStore = Pick<PrismaChainMutationLaneStore, "loadOrCreate" | "acquire" | "release">;
type EscrowSnapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  laneStore?: MutationLaneStore;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredCancellation;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  verifyFinalized?: typeof verifyFinalizedManagedCancellation;
  signal?: AbortSignal;
}>;

function boundedFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Managed cancellation dispatch failed";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Managed cancellation dispatch failed";
}

function terminalPreparationFailure(error: unknown): boolean {
  return error instanceof Error && [
    "Order is no longer resting; refresh its history before taking another action",
    "Only the order owner can cancel",
    "The order changed before cancellation",
  ].includes(error.message);
}

/** Proves the successful exact signature is reflected in a finalized financial
 * snapshot. Absence alone is never used to infer transaction success; callers
 * invoke this only after that exact journaled signature finalized successfully. */
export async function verifyFinalizedManagedCancellation(input: Readonly<{
  runtime: SolanaRuntime;
  walletAddress: Address;
  marketId: bigint;
  orderId: bigint;
  minimumFinalizedSlot: bigint;
  expectedNonce?: bigint;
  signal?: AbortSignal;
}>, dependencies: Readonly<{
  read?: (runtime: SolanaRuntime, value: Readonly<{ marketId: bigint; wallet: Address }>, options: Readonly<{
    signal?: AbortSignal;
    includeOrderBook: true;
    minimumFinalizedSlot: bigint;
  }>) => Promise<EscrowSnapshot>;
}> = {}): Promise<Readonly<{ finalizedSlot: bigint; nextNonce: bigint }>> {
  const read = dependencies.read ?? readGooseyEscrow;
  const snapshot = await read(input.runtime, { marketId: input.marketId, wallet: input.walletAddress }, {
    signal: input.signal,
    includeOrderBook: true,
    minimumFinalizedSlot: input.minimumFinalizedSlot,
  });
  if (snapshot.wallet !== input.walletAddress || snapshot.marketState.marketId !== input.marketId
    || snapshot.finalizedSlot < input.minimumFinalizedSlot || !snapshot.registered || !snapshot.seat
    || !snapshot.orderBook?.reservesReconciled) {
    throw new Error("Finalized cancellation snapshot is incomplete or mismatched");
  }
  if (snapshot.orderBook.orders.some(order => order.id === input.orderId)) {
    throw new Error("Finalized cancellation has not removed the exact resting order");
  }
  if (input.expectedNonce !== undefined && snapshot.seat.nextNonce !== input.expectedNonce + 1n) {
    throw new Error("Finalized cancellation nonce does not match the signed owner mutation");
  }
  return Object.freeze({ finalizedSlot: snapshot.finalizedSlot, nextNonce: snapshot.seat.nextNonce });
}

/** Dispatches one durable app-managed owner cancellation. It journals exact
 * signed bytes before send, never replaces ambiguous bytes, serializes every
 * wallet/market mutation, and requires a finalized post-state proof. */
export async function dispatchManagedCancellationCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const laneStore = dependencies.laneStore
    ?? new PrismaChainMutationLaneStore((dependencies.database ?? db) as never);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-cancellation-dispatcher";
  const token = randomBytes(32).toString("base64url");
  const laneToken = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "CANCEL_ORDER" || command.identity.cluster !== runtime.cluster
    || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed cancellation command does not match the pinned deployment");
  }
  if (!["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN", "FAILED_RETRYABLE"].includes(command.state.status)) {
    return store.publicStatus(commandId);
  }
  const envelope = envelopeSchema.parse(JSON.parse(command.identity.requestJson));
  const participant = await (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(
    command.identity.actorId,
    env,
    dependencies.database as never,
  );
  const request = envelope.request;

  const startedAt = now();
  command = await store.acquireLease(commandId, {
    expectedRevision: command.state.revision,
    owner,
    token,
    now: startedAt,
    expiresAt: new Date(startedAt.getTime() + 5 * 60_000),
  });
  const fence = () => ({ owner, token, epoch: command.state.leaseEpoch, now: now() });
  const laneKey = {
    genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress,
    walletAddress: participant.address,
    chainMarketId: request.chainMarketId,
  };
  let lane: ChainMutationLane | null = null;
  const releaseLane = async () => {
    if (!lane?.lease) return;
    lane = await laneStore.release({
      ...laneKey,
      expectedRevision: lane.revision,
      owner,
      token: laneToken,
      epoch: lane.leaseEpoch,
      now: now(),
    });
  };

  try {
    lane = await laneStore.loadOrCreate(laneKey);
    lane = await laneStore.acquire({
      ...laneKey,
      expectedRevision: lane.revision,
      owner,
      token: laneToken,
      now: now(),
      expiresAt: new Date(now().getTime() + 5 * 60_000),
    });

    if (["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"].includes(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) {
        throw new Error("Pending managed cancellation has no recent-blockhash wire journal");
      }
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(
        createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 },
      )))({ signature: wire.transactionSignature, lastValidBlockHeight: wire.lastValidBlockHeight,
        signal: dependencies.signal });
      if (tracked.signature !== wire.transactionSignature) {
        throw new Error("Cancellation reconciliation returned a different transaction signature");
      }
      if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
        await (dependencies.verifyFinalized ?? verifyFinalizedManagedCancellation)({
          runtime,
          walletAddress: participant.address,
          marketId: BigInt(request.chainMarketId),
          orderId: BigInt(request.orderId),
          minimumFinalizedSlot: tracked.executionSlot,
          signal: dependencies.signal,
        });
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "FINALIZED",
        });
        try { await releaseLane(); } catch { /* bounded lease remains fenced */ }
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_CANCELLATION_REJECTED",
          errorMessage: "The finalized settlement program rejected this cancellation.",
        });
        try { await releaseLane(); } catch { /* bounded lease remains fenced */ }
      } else if (command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "UNKNOWN",
        });
        // Keep the mutation lane until its bounded expiry. The exact signed
        // bytes may still land while their recent blockhash remains valid.
      }
      return store.publicStatus(commandId);
    }

    if (command.state.status === "FAILED_RETRYABLE") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "ACCEPTED",
      });
    }
    if (command.state.status === "ACCEPTED") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "PREPARED",
      });
    }
    const sponsor = await (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env);
    const prepared = await (dependencies.prepare ?? prepareSponsoredCancellation)({
      runtime,
      participant,
      sponsor,
      marketId: BigInt(request.chainMarketId),
      orderId: BigInt(request.orderId),
      signal: dependencies.signal,
    });
    if (request.expectedVersion !== undefined && prepared.bookRevision !== BigInt(request.expectedVersion)) {
      throw new Error("The order changed before cancellation");
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
      onPrepared: () => undefined,
      signal: dependencies.signal,
    });
    if (submission.signature !== prepared.signed.signature
      || submission.lastValidBlockHeight !== prepared.signed.lastValidBlockHeight
      || submission.signedWireBase64 !== prepared.signed.signedWireBase64) {
      throw new Error("Cancellation submission receipt differs from the journaled signed transaction");
    }
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
    if (tracked.signature !== submission.signature) {
      throw new Error("Cancellation reconciliation returned a different transaction signature");
    }
    if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
      await (dependencies.verifyFinalized ?? verifyFinalizedManagedCancellation)({
        runtime,
        walletAddress: participant.address,
        marketId: BigInt(request.chainMarketId),
        orderId: BigInt(request.orderId),
        minimumFinalizedSlot: tracked.executionSlot,
        expectedNonce: prepared.expectedNonce,
        signal: dependencies.signal,
      });
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "FINALIZED",
      });
      try { await releaseLane(); } catch { /* bounded lease remains fenced */ }
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_CANCELLATION_REJECTED",
        errorMessage: "The finalized settlement program rejected this cancellation.",
      });
      try { await releaseLane(); } catch { /* bounded lease remains fenced */ }
    } else {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "UNKNOWN",
      });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
      try {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision,
          ...fence(),
          to: "UNKNOWN",
        });
      } catch { /* a later worker owns authoritative reconciliation */ }
      throw error;
    }
    if (["UNKNOWN", "FINALIZED", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) throw error;
    try { await releaseLane(); } catch { /* bounded lease remains fenced */ }
    try {
      command = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: terminalPreparationFailure(error) ? "FAILED_TERMINAL" : "FAILED_RETRYABLE",
        errorCode: terminalPreparationFailure(error) ? "CANCELLATION_NOT_AVAILABLE" : "CANCELLATION_DISPATCH_FAILED",
        errorMessage: boundedFailure(error),
      });
    } catch { /* stale fence: do not overwrite the authoritative worker */ }
    throw error;
  }
}
