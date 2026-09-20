import { randomBytes } from "node:crypto";

import { address, createSolanaRpc } from "@solana/kit";

import { db } from "@/lib/db";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import type { SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import { loadSolanaMarketAuthoritySigner } from "@/lib/solana/market-authority-service";
import { managedMarketProvisioningEnvelopeSchema } from "@/lib/solana/managed-market-provisioning-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { prepareSponsoredMarketProvisioning } from "@/lib/solana/sponsored-market-provisioning";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus, type TransactionStatusResult } from "@/lib/solana/transaction-status";

type CommandStore = Pick<PrismaChainCommandStore,
  "load" | "loadLatestWireReference" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;

type Envelope = ReturnType<typeof managedMarketProvisioningEnvelopeSchema.parse>;
type Dependencies = Readonly<{
  store?: CommandStore;
  database?: TransactionRunner;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  loadAuthority?: typeof loadSolanaMarketAuthoritySigner;
  prepare?: typeof prepareSponsoredMarketProvisioning;
  submit?: typeof submitSponsoredTransaction;
  track?: (input: Readonly<{ signature: string; lastValidBlockHeight: bigint; signal?: AbortSignal }>) => Promise<TransactionStatusResult>;
  project?: (envelope: Envelope, minimumFinalizedSlot: bigint, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}>;

const RETRYABLE_STARTS = new Set(["ACCEPTED", "PREPARED", "FAILED_RETRYABLE"]);
const UNCERTAIN_AFTER_WIRE = new Set(["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"]);

function seconds(value: string): bigint {
  const millis = new Date(value).getTime();
  if (!Number.isSafeInteger(millis) || millis <= 0 || millis % 1_000 !== 0) throw new Error("Invalid frozen market timestamp");
  return BigInt(millis / 1_000);
}

async function defaultProject(
  runtime: ReturnType<typeof resolveSolanaRuntime>,
  database: TransactionRunner,
  envelope: Envelope,
  minimumFinalizedSlot: bigint,
  signal?: AbortSignal,
): Promise<void> {
  const chainMarketId = BigInt(envelope.request.chainMarketId);
  const snapshot = await readGooseyEscrow(runtime, { marketId: chainMarketId, wallet: runtime.programAddress }, {
    signal,
    minimumFinalizedSlot,
  });
  if (snapshot.market !== envelope.request.marketAddress || snapshot.marketState.marketId !== chainMarketId
    || snapshot.marketState.payoutMilli !== BigInt(envelope.request.payoutMilli)
    || snapshot.marketState.feeBps !== envelope.request.feeBps
    || snapshot.marketState.closesAt !== seconds(envelope.request.closesAt)
    || snapshot.marketState.resolvesAt !== seconds(envelope.request.resolvesAt)) {
    throw new Error("Finalized Solana market does not match the frozen provisioning intent");
  }
  await runSerializableTransaction(database, async tx => {
    const market = await tx.market.findUnique({ where: { id: envelope.request.marketId }, include: { solanaBinding: true } });
    if (!market || market.slug !== envelope.request.marketSlug || market.executionBackend !== "SOLANA"
      || market.collateralAccountId !== null || market.status !== "DRAFT" || market.acceptingOrders
      || market.solanaBinding?.chainMarketId !== envelope.request.chainMarketId
      || market.solanaBinding.marketAddress !== envelope.request.marketAddress
      || market.solanaBinding.genesisHash !== runtime.genesisHash
      || market.solanaBinding.programAddress !== runtime.programAddress) {
      throw new Error("Solana catalog draft changed before provisioning projection");
    }
    const existing = await tx.auditLog.findFirst({
      where: { action: "SOLANA_MARKET_PROVISIONED", entityType: "MARKET", entityId: market.id },
      select: { id: true },
    });
    if (!existing) {
      await tx.auditLog.create({ data: {
        actorUserId: market.createdById,
        action: "SOLANA_MARKET_PROVISIONED",
        entityType: "MARKET",
        entityId: market.id,
        metadata: jsonStringify({
          chainMarketId,
          marketAddress: snapshot.market,
          seatsAddress: snapshot.seats,
          finalizedSlot: snapshot.finalizedSlot,
          visibility: "DRAFT",
          tradingEnabled: false,
          financialLedgerCreated: false,
        }),
      } });
    }
  });
}

function exactReceipt(expected: { signature: string; signedWireBase64: string; lastValidBlockHeight: bigint },
  actual: { signature: string; signedWireBase64: string; lastValidBlockHeight: bigint }): void {
  if (expected.signature !== actual.signature || expected.signedWireBase64 !== actual.signedWireBase64
    || expected.lastValidBlockHeight !== actual.lastValidBlockHeight) {
    throw new Error("Sponsored submission changed the journaled market transaction");
  }
}

/** Executes or reconciles one durable create_market command under a CAS lease. */
export async function dispatchManagedMarketProvisioningCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const database = dependencies.database ?? db;
  const store = dependencies.store ?? new PrismaChainCommandStore(database);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "managed-market-provisioning-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== "PROVISION_MARKET" || command.identity.scope !== "MARKET"
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Managed market command does not match the pinned deployment");
  }
  if (!RETRYABLE_STARTS.has(command.state.status) && !UNCERTAIN_AFTER_WIRE.has(command.state.status)
    && command.state.status !== "FINALIZED") {
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
  const envelope = managedMarketProvisioningEnvelopeSchema.parse(JSON.parse(command.identity.requestJson));
  if (envelope.request.marketId !== command.identity.scopeId) throw new Error("Market command scope changed");

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
    if (UNCERTAIN_AFTER_WIRE.has(command.state.status)) {
      const wire = await store.loadLatestWireReference(commandId);
      if (!wire?.lastValidBlockHeight) throw new Error("Pending market provisioning has no recent-blockhash wire journal");
      const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), {
        ...value, commitment: "finalized", timeoutMs: 45_000,
      })))( { signature: wire.transactionSignature, lastValidBlockHeight: wire.lastValidBlockHeight, signal: dependencies.signal });
      if (tracked.status === "finalized") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
        if (tracked.executionSlot === undefined) throw new Error("Finalized market transaction omitted its execution slot");
        await project(tracked.executionSlot);
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
          errorCode: "ONCHAIN_MARKET_REJECTED", errorMessage: "The finalized Goosey program rejected market provisioning." });
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
    const prepared = await (dependencies.prepare ?? prepareSponsoredMarketProvisioning)({
      runtime,
      authority,
      marketId: BigInt(envelope.request.chainMarketId),
      payoutMilli: BigInt(envelope.request.payoutMilli),
      feeBps: envelope.request.feeBps,
      closesAt: seconds(envelope.request.closesAt),
      resolvesAt: seconds(envelope.request.resolvesAt),
      signal: dependencies.signal,
    });
    if (prepared.market !== address(envelope.request.marketAddress)) throw new Error("Prepared market address changed");
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
      signal: dependencies.signal,
      onPrepared: receipt => exactReceipt(prepared.signed, receipt),
    });
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN" });
    if (submission.status === "unknown") return store.publicStatus(commandId);
    const tracked = await (dependencies.track ?? (value => trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), {
      ...value, commitment: "finalized", timeoutMs: 45_000,
    })))( { signature: submission.signature, lastValidBlockHeight: submission.lastValidBlockHeight, signal: dependencies.signal });
    if (tracked.status === "finalized") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
      if (tracked.executionSlot === undefined) throw new Error("Finalized market transaction omitted its execution slot");
      await project(tracked.executionSlot);
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
    } else if (tracked.status === "failed") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_TERMINAL",
        errorCode: "ONCHAIN_MARKET_REJECTED", errorMessage: "The finalized Goosey program rejected market provisioning." });
    } else {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
    }
    return store.publicStatus(commandId);
  } catch (error) {
    try {
      if (UNCERTAIN_AFTER_WIRE.has(command.state.status) && command.state.status !== "UNKNOWN") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      } else if (!["UNKNOWN", "FAILED_TERMINAL", "PROJECTED"].includes(command.state.status)) {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_RETRYABLE",
          errorCode: "MARKET_PROVISIONING_FAILED", errorMessage: "Managed market provisioning could not be completed safely." });
      }
    } catch {
      // A stale fence means another dispatcher owns the authoritative state.
    }
    throw error;
  }
}
