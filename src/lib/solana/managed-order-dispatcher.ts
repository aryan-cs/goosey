import { randomBytes } from "node:crypto";

import { createSolanaRpc } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainMutationLaneStore, type ChainMutationLane } from "@/lib/solana/chain-mutation-lane";
import { PrismaChainCommandStore, type PublicChainCommandStatus, type StoredChainCommand } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { ensureManagedFeatherAccountReady } from "@/lib/solana/managed-account-readiness";
import { ensureManagedEscrowDeposit } from "@/lib/solana/managed-escrow-dispatcher";
import { planManagedMarketReadiness } from "@/lib/solana/managed-market-readiness";
import { ensureManagedSeatRegistration } from "@/lib/solana/managed-seat-dispatcher";
import { managedOrderRequestSchema } from "@/lib/solana/managed-order-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredOrder } from "@/lib/solana/sponsored-order";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

const envelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("PLACE_ORDER"),
  request: managedOrderRequestSchema.extend({
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  }).strict(),
}).strict();

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;
type MutationLaneStore = Pick<PrismaChainMutationLaneStore, "loadOrCreate" | "acquire" | "release">;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  ensureProvisioned?: typeof ensureManagedFeatherAccountReady;
  ensureSeat?: typeof ensureManagedSeatRegistration;
  ensureEscrow?: typeof ensureManagedEscrowDeposit;
  planReadiness?: typeof planManagedMarketReadiness;
  laneStore?: MutationLaneStore;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredOrder;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  signal?: AbortSignal;
}>;

function expiresAtSeconds(value: string | null | undefined): bigint | undefined {
  if (value == null) return undefined;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    throw new Error("Managed order expiry must use whole UTC seconds");
  }
  return BigInt(milliseconds / 1_000);
}

function boundedFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : "Managed order dispatch failed";
  return raw.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Managed order dispatch failed";
}

/** Signs and submits one accepted order under a fenced lease. Exact wire bytes
 * are committed before the first RPC send. Ambiguous sends become UNKNOWN and
 * are never replaced by freshly signed bytes in this dispatcher. */
export async function dispatchManagedOrderCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-order-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "PLACE_ORDER" || command.identity.cluster !== runtime.cluster
    || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed order command does not match the pinned deployment");
  }
  if (!["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED_RETRYABLE"].includes(command.state.status)) {
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
  const laneToken = randomBytes(32).toString("base64url");
  let mutationLane: ChainMutationLane | null = null;
  let mutationLaneKey: Readonly<{ genesisHash: string; programAddress: string;
    walletAddress: string; chainMarketId: string }> | null = null;
  const laneStore = dependencies.laneStore
    ?? new PrismaChainMutationLaneStore((dependencies.database ?? db) as never);
  const releaseMutationLane = async () => {
    if (!mutationLane?.lease || !mutationLaneKey) return;
    mutationLane = await laneStore.release({ ...mutationLaneKey,
      expectedRevision: mutationLane.revision,
      owner,
      token: laneToken,
      epoch: mutationLane.leaseEpoch,
      now: now(),
    });
  };
  try {
    if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) {
        throw new Error("Pending managed order has no recent-blockhash wire journal");
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
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_ORDER_REJECTED",
          errorMessage: "The finalized settlement program rejected this order.",
        });
      } else {
        // Expiry proves only that these exact bytes cannot land now; RPC
        // history may be incomplete. Retain the receipt for reconciliation and
        // never manufacture a replacement transaction automatically.
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
    const envelope = envelopeSchema.parse(JSON.parse(command.identity.requestJson));
    const request = envelope.request;
    const readiness = await (dependencies.ensureProvisioned ?? ensureManagedFeatherAccountReady)({
      userId: command.identity.actorId,
      env,
      signal: dependencies.signal,
    });
    if (readiness.status !== "ready") throw new Error("Managed feather account is still provisioning");
    mutationLaneKey = {
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      walletAddress: readiness.walletAddress,
      chainMarketId: request.chainMarketId,
    };
    mutationLane = await laneStore.loadOrCreate(mutationLaneKey);
    mutationLane = await laneStore.acquire({ ...mutationLaneKey,
      expectedRevision: mutationLane.revision,
      owner,
      token: laneToken,
      now: now(),
      expiresAt: new Date(now().getTime() + 5 * 60_000),
    });
    const seat = await (dependencies.ensureSeat ?? ensureManagedSeatRegistration)({
      userId: command.identity.actorId,
      marketSlug: request.marketSlug,
    }, {
      database: dependencies.database,
      env,
      signal: dependencies.signal,
    });
    if (seat.status !== "PROJECTED" && seat.status !== "FINALIZED") {
      throw new Error("Managed market seat registration is not finalized");
    }
    let marketReadiness = await (dependencies.planReadiness ?? planManagedMarketReadiness)({
      runtime,
      walletAddress: readiness.walletAddress,
      marketId: BigInt(request.chainMarketId),
      action: request.action,
      limitPriceMilli: BigInt(request.limitPriceMilli),
      quantity: BigInt(request.quantity),
      signal: dependencies.signal,
    });
    if (marketReadiness.status === "register-seat") {
      throw new Error("Managed market seat is not visible in finalized state");
    }
    if (marketReadiness.status === "deposit") {
      const deposit = await (dependencies.ensureEscrow ?? ensureManagedEscrowDeposit)({
        userId: command.identity.actorId,
        marketSlug: request.marketSlug,
        parentCommandId: command.state.id,
        amount: marketReadiness.amount,
      }, {
        database: dependencies.database,
        env,
        signal: dependencies.signal,
      });
      if (deposit.status !== "FINALIZED" && deposit.status !== "PROJECTED") {
        throw new Error("Managed escrow deposit is not finalized");
      }
      marketReadiness = await (dependencies.planReadiness ?? planManagedMarketReadiness)({
        runtime,
        walletAddress: readiness.walletAddress,
        marketId: BigInt(request.chainMarketId),
        action: request.action,
        limitPriceMilli: BigInt(request.limitPriceMilli),
        quantity: BigInt(request.quantity),
        signal: dependencies.signal,
      });
    }
    if (marketReadiness.status !== "ready") {
      throw new Error("Managed market funding is not visible in finalized state");
    }
    const [participant, sponsor] = await Promise.all([
      (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(command.identity.actorId, env),
      (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
    ]);
    const prepared = await (dependencies.prepare ?? prepareSponsoredOrder)({
      runtime,
      participant,
      sponsor,
      marketId: BigInt(request.chainMarketId),
      price: BigInt(request.limitPriceMilli),
      quantity: BigInt(request.quantity),
      outcome: request.outcome,
      action: request.action,
      timeInForce: request.timeInForce,
      selfTrade: request.selfTradePrevention,
      postOnly: request.postOnly,
      expiresAt: expiresAtSeconds(request.expiresAt),
      touches: 16,
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
      onPrepared: () => undefined,
    });
    command = await store.transition(commandId, {
      expectedRevision: command.state.revision,
      ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN",
    });
    if (submission.status === "submitted") {
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
          errorCode: "ONCHAIN_ORDER_REJECTED",
          errorMessage: "The finalized settlement program rejected this order.",
        });
      } else {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      }
    }
    if (command.state.status === "FINALIZED" || command.state.status === "FAILED_TERMINAL") {
      try {
        await releaseMutationLane();
      } catch {
        // The completed order is authoritative; the bounded lane lease may be
        // reclaimed after expiry if release loses its fence.
      }
    }
    return store.publicStatus(commandId);
  } catch (error) {
    // Any post-journal failure is ambiguous: RPC submission may have succeeded
    // even when this worker did not persist the next state. Keep the exact wire
    // reconcilable and never permit a freshly signed automatic replacement.
    if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
      try {
        command = await store.transition(commandId, {
          expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN",
        });
      } catch {
        // Preserve the original failure. A later worker reconciles SIGNED or
        // SUBMITTED from the append-only wire journal after the lease expires.
      }
      throw error;
    }
    if (command.state.status === "UNKNOWN" || command.state.status === "FAILED_TERMINAL"
      || command.state.status === "PROJECTED") throw error;
    try {
      await releaseMutationLane();
    } catch {
      // The lane lease remains bounded and fenced if release races or fails.
    }
    try {
      const failed = await store.transition(commandId, {
        expectedRevision: command.state.revision,
        ...fence(),
        to: "FAILED_RETRYABLE",
        errorCode: "ORDER_DISPATCH_FAILED",
        errorMessage: boundedFailure(error),
      });
      command = failed;
    } catch {
      // Preserve the original failure. A stale fence means another worker owns
      // the authoritative command state and this worker must not overwrite it.
    }
    throw error;
  }
}

export type { StoredChainCommand };
