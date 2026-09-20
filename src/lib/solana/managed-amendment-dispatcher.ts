import { randomBytes } from "node:crypto";

import { createSolanaRpc, type Address } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { type TransactionRunner } from "@/lib/serializable-transaction";
import { type SignedWireInput } from "./chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "./chain-command-store";
import { PrismaChainMutationLaneStore, type ChainMutationLane } from "./chain-mutation-lane";
import { loadAppManagedSolanaSigner } from "./custody-service";
import { readGooseyEscrow } from "./escrow-read";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import { loadSolanaSponsorSigner } from "./sponsor-service";
import { prepareSponsoredReplacement } from "./sponsored-replacement";
import { submitSponsoredTransaction } from "./sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "./transaction-status";

const U64_MAX = (1n << 64n) - 1n;
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= U64_MAX);
const envelopeSchema = z.object({ version: z.literal(1), operation: z.literal("REPLACE_ORDER"), request: z.object({
  marketId: z.string().min(1).max(191), marketSlug: z.string().min(1).max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), chainMarketId: u64,
  orderId: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= U64_MAX),
  expectedVersion: z.number().int().nonnegative(),
  clientOrderId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  limitPriceMilli: z.string().regex(/^[1-9][0-9]{0,5}$/), quantity: z.number().int().min(1).max(10_000_000),
  postOnly: z.boolean(), selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(), cancelOnPause: z.literal(true).optional(),
}).strict() }).strict();

type Store = Pick<PrismaChainCommandStore, "load" | "loadLatestWireReference" | "acquireLease" |
  "transition" | "appendSignedWireBeforeSend" | "publicStatus">;
type LaneStore = Pick<PrismaChainMutationLaneStore, "loadOrCreate" | "acquire" | "release">;
type Snapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;
type Dependencies = Readonly<{ store?: Store; database?: TransactionRunner; env?: Record<string, string | undefined>;
  now?: () => Date; owner?: string; laneStore?: LaneStore; loadParticipant?: typeof loadAppManagedSolanaSigner;
  loadSponsor?: typeof loadSolanaSponsorSigner; prepare?: typeof prepareSponsoredReplacement;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  verifyFinalized?: typeof verifyFinalizedManagedAmendment; signal?: AbortSignal }>;

function expiry(value: string | null | undefined): bigint | null | undefined {
  if (value === undefined || value === null) return value;
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0 || milliseconds % 1_000 !== 0) {
    throw new Error("Managed replacement expiry must use whole UTC seconds");
  }
  return BigInt(milliseconds / 1_000);
}
function failure(error: unknown) {
  return (error instanceof Error ? error.message : "Managed replacement dispatch failed")
    .replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}
function terminal(error: unknown) {
  return error instanceof Error && /no longer resting|Only the order owner|changed before replacement|Insufficient finalized|reviewer wallets|no longer open|exhausted|below the market payout/.test(error.message);
}

/** Proves the exact finalized transaction removed the old order and consumed
 * both sequential owner nonces. A fully filled replacement need not rest. */
export async function verifyFinalizedManagedAmendment(input: Readonly<{ runtime: SolanaRuntime;
  walletAddress: Address; marketId: bigint; orderId: bigint; minimumFinalizedSlot: bigint;
  expectedNonce?: bigint; replacementOrderId?: bigint; outcome?: "YES" | "NO"; action?: "BUY" | "SELL";
  price?: bigint; quantity?: bigint; expiresAt?: bigint | null; signal?: AbortSignal }>, dependencies: Readonly<{
  read?: (runtime: SolanaRuntime, value: Readonly<{ marketId: bigint; wallet: Address }>, options: Readonly<{
    signal?: AbortSignal; includeOrderBook: true; minimumFinalizedSlot: bigint }>) => Promise<Snapshot> }> = {}) {
  const snapshot = await (dependencies.read ?? readGooseyEscrow)(input.runtime,
    { marketId: input.marketId, wallet: input.walletAddress }, { signal: input.signal, includeOrderBook: true,
      minimumFinalizedSlot: input.minimumFinalizedSlot });
  if (snapshot.wallet !== input.walletAddress || snapshot.marketState.marketId !== input.marketId
    || snapshot.finalizedSlot < input.minimumFinalizedSlot || !snapshot.registered || !snapshot.seat
    || !snapshot.orderBook?.reservesReconciled) throw new Error("Finalized replacement snapshot is incomplete or mismatched");
  if (snapshot.orderBook.orders.some(order => order.id === input.orderId)) {
    throw new Error("Finalized replacement has not removed the exact original order");
  }
  if (input.expectedNonce !== undefined && snapshot.seat.nextNonce !== input.expectedNonce + 2n) {
    throw new Error("Finalized replacement nonce does not prove atomic cancel-and-place execution");
  }
  if (input.replacementOrderId !== undefined) {
    if (snapshot.orderBook.nextSequence <= input.replacementOrderId) {
      throw new Error("Finalized replacement order sequence did not advance");
    }
    const resting = snapshot.orderBook.orders.find(order => order.id === input.replacementOrderId);
    if (resting && (resting.wallet !== input.walletAddress || resting.ownerSeat !== snapshot.seat.index
      || resting.outcome !== input.outcome || resting.action !== input.action || resting.limitPrice !== input.price
      || resting.remaining <= 0n || input.quantity === undefined || resting.remaining > input.quantity
      || resting.expiresAt !== input.expiresAt)) {
      throw new Error("Finalized resting replacement differs from the signed request");
    }
  }
  return Object.freeze({ finalizedSlot: snapshot.finalizedSlot, nextNonce: snapshot.seat.nextNonce });
}

export async function dispatchManagedAmendmentCommand(commandId: string,
  dependencies: Dependencies = {}): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env, runtime = resolveSolanaRuntime(env);
  const store = dependencies.store ?? new PrismaChainCommandStore(dependencies.database ?? db);
  const laneStore = dependencies.laneStore ?? new PrismaChainMutationLaneStore((dependencies.database ?? db) as never);
  const now = dependencies.now ?? (() => new Date()), owner = dependencies.owner ?? "managed-amendment-dispatcher";
  const token = randomBytes(32).toString("base64url"), laneToken = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "REPLACE_ORDER" || command.identity.cluster !== runtime.cluster
    || command.identity.genesisHash !== runtime.genesisHash || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed replacement command does not match the pinned deployment");
  }
  if (!["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN", "FAILED_RETRYABLE"].includes(command.state.status)) {
    return store.publicStatus(commandId);
  }
  const request = envelopeSchema.parse(JSON.parse(command.identity.requestJson)).request;
  const participant = await (dependencies.loadParticipant ?? loadAppManagedSolanaSigner)(command.identity.actorId,
    env, dependencies.database as never);
  const started = now();
  command = await store.acquireLease(commandId, { expectedRevision: command.state.revision, owner, token, now: started,
    expiresAt: new Date(started.getTime() + 300_000) });
  const fence = () => ({ owner, token, epoch: command.state.leaseEpoch, now: now() });
  const laneKey = { genesisHash: runtime.genesisHash, programAddress: runtime.programAddress,
    walletAddress: participant.address, chainMarketId: request.chainMarketId };
  let lane: ChainMutationLane | null = null;
  const release = async () => { if (lane?.lease) lane = await laneStore.release({ ...laneKey,
    expectedRevision: lane.revision, owner, token: laneToken, epoch: lane.leaseEpoch, now: now() }); };
  const verify = async (slot: bigint, prepared?: Awaited<ReturnType<typeof prepareSponsoredReplacement>>) =>
    (dependencies.verifyFinalized ?? verifyFinalizedManagedAmendment)({ runtime, walletAddress: participant.address,
      marketId: BigInt(request.chainMarketId), orderId: BigInt(request.orderId), minimumFinalizedSlot: slot,
      ...(prepared ? { expectedNonce: prepared.expectedNonce, replacementOrderId: prepared.replacementOrderId,
        outcome: prepared.outcome, action: prepared.action, price: prepared.price, quantity: prepared.quantity,
        expiresAt: prepared.expiresAt } : {}), signal: dependencies.signal });
  try {
    lane = await laneStore.loadOrCreate(laneKey);
    lane = await laneStore.acquire({ ...laneKey, expectedRevision: lane.revision, owner, token: laneToken, now: now(),
      expiresAt: new Date(now().getTime() + 300_000) });
    if (["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"].includes(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) throw new Error("Pending managed replacement has no recent-blockhash wire journal");
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 })))({ signature: wire.transactionSignature,
        lastValidBlockHeight: wire.lastValidBlockHeight, signal: dependencies.signal });
      if (tracked.signature !== wire.transactionSignature) throw new Error("Replacement reconciliation returned a different signature");
      if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
        await verify(tracked.executionSlot);
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
        try { await release(); } catch { /* bounded lane expires safely */ }
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
          to: "FAILED_TERMINAL", errorCode: "ONCHAIN_REPLACEMENT_REJECTED",
          errorMessage: "The atomic on-chain replacement was rejected; the original order was preserved." });
        try { await release(); } catch { /* bounded lane expires safely */ }
      } else if (command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      }
      return store.publicStatus(commandId);
    }
    if (command.state.status === "FAILED_RETRYABLE") command = await store.transition(commandId,
      { expectedRevision: command.state.revision, ...fence(), to: "ACCEPTED" });
    if (command.state.status === "ACCEPTED") command = await store.transition(commandId,
      { expectedRevision: command.state.revision, ...fence(), to: "PREPARED" });
    const sponsor = await (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env);
    const prepared = await (dependencies.prepare ?? prepareSponsoredReplacement)({ runtime, participant, sponsor,
      marketId: BigInt(request.chainMarketId), orderId: BigInt(request.orderId), price: BigInt(request.limitPriceMilli),
      quantity: BigInt(request.quantity), postOnly: request.postOnly, selfTrade: request.selfTradePrevention,
      expiresAt: expiry(request.expiresAt), touches: 8, signal: dependencies.signal });
    if (prepared.bookRevision !== BigInt(request.expectedVersion)) throw new Error("The order changed before replacement");
    const wire: SignedWireInput = { commandId, sequence: command.state.attemptCount,
      leaseEpoch: command.state.leaseEpoch, commandRevision: command.state.revision,
      signedWireBase64: prepared.signed.signedWireBase64, transactionSignature: prepared.signed.signature,
      recentBlockhash: prepared.signed.recentBlockhash, lastValidBlockHeight: prepared.signed.lastValidBlockHeight,
      durableNonceAddress: null, feePayerAddress: prepared.signed.sponsorAddress,
      signerAddresses: [prepared.signed.sponsorAddress, prepared.signed.participantAddress] };
    command = (await store.appendSignedWireBeforeSend({ wire, ...fence() })).command;
    const submission = await (dependencies.submit ?? submitSponsoredTransaction)({ runtime, signed: prepared.signed,
      onPrepared: () => undefined, signal: dependencies.signal });
    if (submission.signature !== prepared.signed.signature
      || submission.lastValidBlockHeight !== prepared.signed.lastValidBlockHeight
      || submission.signedWireBase64 !== prepared.signed.signedWireBase64) {
      throw new Error("Replacement submission receipt differs from the journaled transaction");
    }
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN" });
    if (submission.status === "unknown") return store.publicStatus(commandId);
    const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl),
      { ...value, commitment: "finalized", timeoutMs: 45_000 })))({ signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight, signal: dependencies.signal });
    if (tracked.signature !== submission.signature) throw new Error("Replacement reconciliation returned a different signature");
    if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
      await verify(tracked.executionSlot, prepared);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
      try { await release(); } catch { /* bounded lane expires safely */ }
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
        to: "FAILED_TERMINAL", errorCode: "ONCHAIN_REPLACEMENT_REJECTED",
        errorMessage: "The atomic on-chain replacement was rejected; the original order was preserved." });
      try { await release(); } catch { /* bounded lane expires safely */ }
    } else command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
    return store.publicStatus(commandId);
  } catch (error) {
    if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
      try { command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" }); }
      catch { /* later exact-signature reconciliation owns state */ }
      throw error;
    }
    if (["UNKNOWN", "FINALIZED", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) throw error;
    try { await release(); } catch { /* bounded lane expires safely */ }
    try { command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: terminal(error) ? "FAILED_TERMINAL" : "FAILED_RETRYABLE",
      errorCode: terminal(error) ? "REPLACEMENT_NOT_AVAILABLE" : "REPLACEMENT_DISPATCH_FAILED",
      errorMessage: failure(error) || "Managed replacement dispatch failed" }); } catch { /* stale worker */ }
    throw error;
  }
}
