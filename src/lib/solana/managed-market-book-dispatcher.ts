import { randomBytes } from "node:crypto";

import { address, createSolanaRpc, getBase64EncodedWireTransaction, getSignatureFromTransaction } from "@solana/kit";

import { db } from "@/lib/db";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import type { SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { GOOSEY_BOOK_BYTES, GOOSEY_BOOK_GROWTH } from "@/lib/solana/exchange-client";
import { ensureManagedMarketBookCommand, managedMarketBookEnvelopeSchema,
  nextManagedMarketBookStep } from "@/lib/solana/managed-market-book-service";
import { prepareManagedMarketBookTransaction, readManagedMarketBookState } from "@/lib/solana/managed-market-book-transaction";
import { loadSolanaMarketAuthoritySigner } from "@/lib/solana/market-authority-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { submitSignedWalletTransaction } from "@/lib/solana/submit-transfer";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;
type Envelope = ReturnType<typeof managedMarketBookEnvelopeSchema.parse>;
type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  loadAuthority?: typeof loadSolanaMarketAuthoritySigner;
  prepare?: typeof prepareManagedMarketBookTransaction;
  submit?: typeof submitSignedWalletTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  project?: (envelope: Envelope, minimumFinalizedSlot: bigint, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}>;

const RETRYABLE_STARTS = new Set(["ACCEPTED", "PREPARED", "FAILED_RETRYABLE"]);
const RETAINED_WIRE = new Set(["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"]);

function expectedPostState(step: Envelope["request"]["step"]): { ready: boolean; size: number } {
  if (step.kind === "create") return { ready: false, size: GOOSEY_BOOK_GROWTH };
  if (step.kind === "grow") return { ready: false, size: Math.min(step.expectedSize + GOOSEY_BOOK_GROWTH, GOOSEY_BOOK_BYTES) };
  return { ready: true, size: GOOSEY_BOOK_BYTES };
}

async function defaultProject(runtime: ReturnType<typeof resolveSolanaRuntime>, database: TransactionRunner,
  envelope: Envelope, minimumFinalizedSlot: bigint, signal?: AbortSignal): Promise<void> {
  const observed = await readManagedMarketBookState({ runtime, marketAddress: address(envelope.request.marketAddress),
    minimumFinalizedSlot, signal });
  const expected = expectedPostState(envelope.request.step);
  if (observed.ready !== expected.ready || observed.size !== expected.size) {
    throw new Error("Finalized order-book state does not match the completed provisioning step");
  }
  if (observed.ready) {
    const snapshot = await readGooseyEscrow(runtime, { marketId: BigInt(envelope.request.chainMarketId),
      wallet: runtime.programAddress }, { includeOrderBook: true, minimumFinalizedSlot: observed.finalizedSlot, signal });
    if (snapshot.market !== envelope.request.marketAddress || !snapshot.orderBook?.reservesReconciled) {
      throw new Error("Finalized canonical order book failed full reconciliation");
    }
  }
  const next = nextManagedMarketBookStep(observed);
  await runSerializableTransaction(database, async tx => {
    const market = await tx.market.findUnique({ where: { id: envelope.request.marketId }, include: { solanaBinding: true } });
    if (!market || market.slug !== envelope.request.marketSlug || market.executionBackend !== "SOLANA"
      || market.collateralAccountId !== null || market.status !== "DRAFT" || market.acceptingOrders
      || market.solanaBinding?.chainMarketId !== envelope.request.chainMarketId
      || market.solanaBinding.marketAddress !== envelope.request.marketAddress
      || market.solanaBinding.genesisHash !== runtime.genesisHash
      || market.solanaBinding.programAddress !== runtime.programAddress) {
      throw new Error("Solana catalog draft changed during order-book provisioning");
    }
    if (next) {
      await ensureManagedMarketBookCommand(tx, { runtime, actorUserId: market.createdById,
        marketId: market.id, marketSlug: market.slug, chainMarketId: envelope.request.chainMarketId,
        marketAddress: envelope.request.marketAddress, step: next });
      return;
    }
    const existing = await tx.auditLog.findFirst({ where: {
      action: "SOLANA_MARKET_BOOK_READY", entityType: "MARKET", entityId: market.id,
    }, select: { id: true } });
    if (!existing) await tx.auditLog.create({ data: { actorUserId: market.createdById,
      action: "SOLANA_MARKET_BOOK_READY", entityType: "MARKET", entityId: market.id,
      metadata: jsonStringify({ chainMarketId: envelope.request.chainMarketId,
        marketAddress: envelope.request.marketAddress, bookAddress: observed.book,
        finalizedSlot: observed.finalizedSlot, tradingEnabled: false,
        nextRequiredStage: "TERMS_REVIEW_AND_RESOLUTION" }) } });
  });
}

export async function dispatchManagedMarketBookCommand(commandId: string, dependencies: Dependencies = {})
  : Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const database = dependencies.database ?? db;
  const store = dependencies.store ?? new PrismaChainCommandStore(database);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-market-book-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "PROVISION_MARKET_BOOK" || command.identity.scope !== "MARKET"
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) throw new Error("Managed book command does not match the pinned deployment");
  if (!RETRYABLE_STARTS.has(command.state.status) && !RETAINED_WIRE.has(command.state.status)
    && command.state.status !== "FINALIZED") return store.publicStatus(commandId);
  const startedAt = now();
  command = await store.acquireLease(commandId, { expectedRevision: command.state.revision, owner, token,
    now: startedAt, expiresAt: new Date(startedAt.getTime() + 5 * 60_000) });
  const fence = () => ({ owner, token, epoch: command.state.leaseEpoch, now: now() });
  const envelope = managedMarketBookEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
  if (envelope.request.marketId !== command.identity.scopeId) throw new Error("Book command scope changed");
  const project = (slot: bigint) => dependencies.project
    ? dependencies.project(envelope, slot, dependencies.signal)
    : defaultProject(runtime, database, envelope, slot, dependencies.signal);
  try {
    if (command.state.status === "FINALIZED") {
      await project(0n);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      return store.publicStatus(commandId);
    }
    if (command.state.status === "FAILED_RETRYABLE" && command.state.finalizedAt !== null) {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
      await project(0n);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      return store.publicStatus(commandId);
    }
    if (RETAINED_WIRE.has(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) throw new Error("Pending book provisioning has no recent-blockhash wire journal");
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl),
        { ...value, commitment: "finalized", timeoutMs: 45_000 })))({ signature: wire.transactionSignature,
        lastValidBlockHeight: wire.lastValidBlockHeight, signal: dependencies.signal });
      if (tracked.signature !== wire.transactionSignature) throw new Error("Book reconciliation returned a different signature");
      if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
        await project(tracked.executionSlot);
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_BOOK_STEP_REJECTED", errorMessage: "The finalized Goosey program rejected this order-book provisioning step." });
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
    const authority = await (dependencies.loadAuthority ?? loadSolanaMarketAuthoritySigner)(env);
    const prepared = await (dependencies.prepare ?? prepareManagedMarketBookTransaction)({ runtime, authority,
      marketId: BigInt(envelope.request.chainMarketId), marketAddress: address(envelope.request.marketAddress),
      step: envelope.request.step, signal: dependencies.signal });
    const wire: SignedWireInput = { commandId, sequence: command.state.attemptCount,
      leaseEpoch: command.state.leaseEpoch, commandRevision: command.state.revision,
      signedWireBase64: prepared.receipt.signedWireBase64,
      transactionSignature: prepared.receipt.signature, recentBlockhash: prepared.receipt.recentBlockhash,
      lastValidBlockHeight: prepared.receipt.lastValidBlockHeight, durableNonceAddress: null,
      feePayerAddress: prepared.receipt.authorityAddress, signerAddresses: [prepared.receipt.authorityAddress] };
    command = (await store.appendSignedWireBeforeSend({ wire, ...fence() })).command;
    const submission = await (dependencies.submit ?? submitSignedWalletTransaction)({ runtime,
      prepared: prepared.prepared, signed: prepared.signed, signal: dependencies.signal,
      onPrepared: receipt => {
        if (receipt.signature !== prepared.receipt.signature
          || receipt.signedWireBase64 !== prepared.receipt.signedWireBase64
          || receipt.lastValidBlockHeight !== prepared.receipt.lastValidBlockHeight
          || getSignatureFromTransaction(prepared.signed) !== receipt.signature
          || getBase64EncodedWireTransaction(prepared.signed) !== receipt.signedWireBase64) {
          throw new Error("Book submission changed the journaled signed transaction");
        }
      } });
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN" });
    if (submission.status === "unknown") return store.publicStatus(commandId);
    const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl),
      { ...value, commitment: "finalized", timeoutMs: 45_000 })))({ signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight, signal: dependencies.signal });
    if (tracked.signature !== submission.signature) throw new Error("Book tracking returned a different signature");
    if (tracked.status === "finalized" && tracked.executionSlot !== undefined) {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
      await project(tracked.executionSlot);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_BOOK_STEP_REJECTED", errorMessage: "The finalized Goosey program rejected this order-book provisioning step." });
    } else command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (RETAINED_WIRE.has(command.state.status) && command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_RETRYABLE",
          errorCode: "BOOK_PROVISIONING_FAILED", errorMessage: "Managed order-book provisioning could not be completed safely." });
      }
    } catch { /* another fenced dispatcher owns authoritative state */ }
    throw error;
  }
}
