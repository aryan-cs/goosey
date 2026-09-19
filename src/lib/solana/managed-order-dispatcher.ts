import { randomBytes } from "node:crypto";

import { z } from "zod";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus, type StoredChainCommand } from "@/lib/solana/chain-command-store";
import { loadAppManagedSolanaSigner } from "@/lib/solana/custody-service";
import { managedOrderRequestSchema } from "@/lib/solana/managed-order-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { prepareSponsoredOrder } from "@/lib/solana/sponsored-order";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";

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
  "load" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;

type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  prepare?: typeof prepareSponsoredOrder;
  submit?: typeof submitSponsoredTransaction;
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
  if (!["ACCEPTED", "PREPARED", "FAILED_RETRYABLE"].includes(command.state.status)) {
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
    return store.publicStatus(commandId);
  } catch (error) {
    // UNKNOWN has deliberately released its lease and must only be reconciled.
    if (command.state.status === "UNKNOWN") throw error;
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
