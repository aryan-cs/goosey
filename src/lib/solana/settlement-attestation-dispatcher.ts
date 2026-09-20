import { randomBytes } from "node:crypto";

import { address, createSolanaRpc, getBase64Encoder, type KeyPairSigner } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { runSerializableTransaction, type TransactionRunner } from "@/lib/serializable-transaction";
import type { SignedWireInput } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import {
  deriveGooseyDatabaseSettlementAttestationAddresses,
  readDatabaseSettlementAttestationAccount,
  readDatabaseSettlementAttestationConfigAccount,
} from "@/lib/solana/database-settlement-client";
import { prepareDatabaseSettlementAttestation } from "@/lib/solana/database-settlement-transaction";
import { persistFinalizedProgramReceipt } from "@/lib/solana/event-journal";
import { readFinalizedProgramEvents } from "@/lib/solana/program-event-read";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import { loadSettlementAttestationAuthority } from "@/lib/solana/settlement-attestation-authority";
import {
  resolveSettlementDatabaseDomain,
  SETTLEMENT_ATTESTATION_OPERATION,
} from "@/lib/solana/settlement-attestation";
import { loadSolanaSponsorSigner } from "@/lib/solana/sponsor-service";
import { submitSponsoredTransaction } from "@/lib/solana/sponsored-submission";
import { trackTransactionStatus } from "@/lib/solana/transaction-status";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const envelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal(SETTLEMENT_ATTESTATION_OPERATION),
  request: z.object({
    schema: z.literal("goosey.database-settlement-attestation"),
    version: z.literal(1),
    marketDigest: digest,
    settlementDigest: digest,
    outcome: z.enum(["YES", "NO", "VOID"]),
    resolvedAt: z.string().datetime({ offset: true }),
    resolvedAtUnixSeconds: decimal,
    settlementCount: z.number().int().nonnegative(),
    totalPayoutMilli: decimal,
  }).strict(),
}).strict();

type Store = Pick<PrismaChainCommandStore,
  "load" | "acquireLease" | "transition" | "appendSignedWireBeforeSend" | "publicStatus">;

type Dependencies = Readonly<{
  database?: TransactionRunner & typeof db;
  store?: Store;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  owner?: string;
  loadAuthority?: (env: Record<string, string | undefined>) => Promise<KeyPairSigner>;
  loadSponsor?: typeof loadSolanaSponsorSigner;
  signal?: AbortSignal;
}>;

function bytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function boundedFailure(error: unknown): string {
  return (error instanceof Error ? error.message : "Settlement attestation dispatch failed")
    .replace(/[\r\n\t]+/g, " ").slice(0, 1_000);
}

async function projectFinalizedReceipt(input: {
  commandId: string;
  signature: string;
  request: z.infer<typeof envelopeSchema>["request"];
  authority: KeyPairSigner;
  databaseDomainHex: string;
  database: TransactionRunner & typeof db;
  runtime: ReturnType<typeof resolveSolanaRuntime>;
  signal?: AbortSignal;
}) {
  const receipt = await readFinalizedProgramEvents(input.runtime, input.signature, { signal: input.signal });
  if (receipt.outcome !== "success") throw new Error("Finalized settlement attestation transaction did not succeed");
  const matching = receipt.records.filter(record => record.event.kind === "DatabaseSettlementAttested");
  if (matching.length !== 1) throw new Error("Finalized settlement attestation event is missing or ambiguous");
  const event = matching[0].event;
  if (event.kind !== "DatabaseSettlementAttested"
    || event.authority !== input.authority.address
    || event.databaseMarketDigest !== input.request.marketDigest
    || event.settlementDigest !== input.request.settlementDigest
    || event.outcome !== BigInt(input.request.outcome === "YES" ? 0 : input.request.outcome === "NO" ? 1 : 2)
    || event.totalPositions !== BigInt(input.request.settlementCount)
    || event.totalPayoutMilli !== BigInt(input.request.totalPayoutMilli)
    || event.resolvedAt !== BigInt(input.request.resolvedAtUnixSeconds)) {
    throw new Error("Finalized settlement attestation event does not match its command");
  }

  const derived = await deriveGooseyDatabaseSettlementAttestationAddresses({
    programAddress: input.runtime.programAddress,
    databaseMarketDigest: bytes(input.request.marketDigest),
  });
  if (event.attestation !== derived.attestation) throw new Error("Finalized settlement attestation event used a noncanonical PDA");
  const rpc = createSolanaRpc(input.runtime.rpcUrl);
  const snapshot = await rpc.getMultipleAccounts([derived.attestationConfig, derived.attestation], {
    encoding: "base64",
    commitment: "finalized",
    minContextSlot: receipt.slot,
  }).send({ abortSignal: input.signal ?? AbortSignal.timeout(15_000) });
  if (snapshot.context.slot < receipt.slot || snapshot.value.length !== 2 || !snapshot.value[0] || !snapshot.value[1]) {
    throw new Error("Finalized settlement attestation accounts are unavailable");
  }
  const raw = (accountAddress: typeof derived.attestation, account: NonNullable<(typeof snapshot.value)[number]>) => {
    if (!Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== "base64") {
      throw new Error("Invalid finalized settlement attestation account encoding");
    }
    return { address: accountAddress, owner: address(account.owner), executable: account.executable,
      data: new Uint8Array(getBase64Encoder().encode(account.data[0])) };
  };
  await readDatabaseSettlementAttestationConfigAccount({
    programAddress: input.runtime.programAddress,
    config: derived.config,
    authority: input.authority.address,
    databaseDomain: bytes(input.databaseDomainHex),
  }, raw(derived.attestationConfig, snapshot.value[0]));
  await readDatabaseSettlementAttestationAccount({
    programAddress: input.runtime.programAddress,
    config: derived.config,
    attestationConfig: derived.attestationConfig,
    authority: input.authority.address,
    databaseMarketDigest: bytes(input.request.marketDigest),
    settlementDigest: bytes(input.request.settlementDigest),
    outcome: input.request.outcome,
    totalPositions: BigInt(input.request.settlementCount),
    totalPayoutMilli: BigInt(input.request.totalPayoutMilli),
    resolvedAt: BigInt(input.request.resolvedAtUnixSeconds),
  }, raw(derived.attestation, snapshot.value[1]));

  await runSerializableTransaction(input.database, async tx => {
    await persistFinalizedProgramReceipt(tx, receipt);
    const attestation = await tx.marketSettlementAttestation.findUnique({ where: { commandId: input.commandId } });
    if (!attestation || attestation.digest !== input.request.settlementDigest || attestation.marketDigest !== input.request.marketDigest) {
      throw new Error("Settlement attestation database binding changed");
    }
    if (attestation.signature !== null || attestation.slot !== null || attestation.attestedAt !== null) {
      if (attestation.signature !== receipt.signature || attestation.slot !== receipt.slot) {
        throw new Error("Settlement attestation receipt conflicts with its immutable database record");
      }
      return;
    }
    await tx.marketSettlementAttestation.update({
      where: { id: attestation.id },
      data: { signature: receipt.signature, slot: receipt.slot, attestedAt: new Date() },
    });
  });
}

/** Dispatches a fresh attestation command. Exact signed bytes are committed
 * before send; final projection requires both the finalized event and PDA. */
export async function dispatchSettlementAttestationCommand(
  commandId: string,
  dependencies: Dependencies = {},
): Promise<PublicChainCommandStatus> {
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const databaseDomainHex = resolveSettlementDatabaseDomain(env);
  const database = dependencies.database ?? db;
  const store = dependencies.store ?? new PrismaChainCommandStore(database);
  const now = dependencies.now ?? (() => new Date());
  const owner = dependencies.owner ?? "settlement-attestation-dispatcher";
  const token = randomBytes(32).toString("base64url");
  let command = await store.load(commandId);
  if (command.identity.operation !== SETTLEMENT_ATTESTATION_OPERATION
    || command.identity.cluster !== runtime.cluster || command.identity.genesisHash !== runtime.genesisHash
    || command.identity.programAddress !== runtime.programAddress) {
    throw new Error("Settlement attestation command does not match the pinned deployment");
  }
  const request = envelopeSchema.parse(JSON.parse(command.identity.requestJson)).request;
  if (command.state.status === "PROJECTED" || command.state.status === "FAILED_TERMINAL") return store.publicStatus(commandId);
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
    const [authority, sponsor] = await Promise.all([
      (dependencies.loadAuthority ?? loadSettlementAttestationAuthority)(env),
      (dependencies.loadSponsor ?? loadSolanaSponsorSigner)(env),
    ]);
    if (command.state.status === "FINALIZED") {
      const wire = await database.chainCommandSignedWire.findFirst({
        where: { commandId }, orderBy: { sequence: "desc" }, select: { transactionSignature: true },
      });
      if (!wire) throw new Error("Finalized settlement attestation has no signed-wire journal");
      await projectFinalizedReceipt({ commandId, signature: wire.transactionSignature, request, authority,
        databaseDomainHex, database, runtime, signal: dependencies.signal });
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      return store.publicStatus(commandId);
    }
    if (["SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN"].includes(command.state.status)) {
      const wire = await database.chainCommandSignedWire.findFirst({
        where: { commandId },
        orderBy: { sequence: "desc" },
        select: { transactionSignature: true, lastValidBlockHeight: true },
      });
      if (!wire?.lastValidBlockHeight) throw new Error("Pending settlement attestation has no recent-blockhash journal");
      const tracked = await trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), {
        signature: wire.transactionSignature,
        lastValidBlockHeight: wire.lastValidBlockHeight,
        commitment: "finalized",
        timeoutMs: 5_000,
        signal: dependencies.signal,
      });
      if (tracked.status === "finalized") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
        await projectFinalizedReceipt({ commandId, signature: wire.transactionSignature, request, authority,
          databaseDomainHex, database, runtime, signal: dependencies.signal });
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
      } else if (tracked.status === "failed") {
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
          to: "FAILED_TERMINAL", errorCode: "ATTESTATION_REJECTED",
          errorMessage: "The finalized Goosey program rejected the settlement receipt." });
      } else if (tracked.status === "expired") {
        // Exact replay is safe because the program binds one immutable digest
        // to the market PDA. A later attempt cannot publish different data.
        command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
          to: "FAILED_RETRYABLE", errorCode: "ATTESTATION_WIRE_EXPIRED",
          errorMessage: "The prior signed receipt expired without a finalized observation; retry the same immutable receipt." });
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
    const prepared = await prepareDatabaseSettlementAttestation({
      runtime,
      authority,
      sponsor,
      databaseMarketDigest: bytes(request.marketDigest),
      settlementDigest: bytes(request.settlementDigest),
      outcome: request.outcome,
      totalPositions: BigInt(request.settlementCount),
      totalPayoutMilli: BigInt(request.totalPayoutMilli),
      resolvedAt: BigInt(request.resolvedAtUnixSeconds),
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
    command = (await store.appendSignedWireBeforeSend({ wire, ...fence() })).command;
    const submission = await submitSponsoredTransaction({ runtime, signed: prepared.signed,
      onPrepared: () => undefined, signal: dependencies.signal });
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
      to: submission.status === "submitted" ? "SUBMITTED" : "UNKNOWN" });
    if (submission.status !== "submitted") return store.publicStatus(commandId);
    const tracked = await trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), {
      signature: submission.signature,
      lastValidBlockHeight: submission.lastValidBlockHeight,
      commitment: "finalized",
      timeoutMs: 45_000,
      signal: dependencies.signal,
    });
    if (tracked.status === "failed") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(),
        to: "FAILED_TERMINAL", errorCode: "ATTESTATION_REJECTED", errorMessage: "The finalized Goosey program rejected the settlement receipt." });
      return store.publicStatus(commandId);
    }
    if (tracked.status !== "finalized") {
      command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" });
      return store.publicStatus(commandId);
    }
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FINALIZED" });
    await projectFinalizedReceipt({ commandId, signature: submission.signature, request, authority,
      databaseDomainHex, database, runtime, signal: dependencies.signal });
    command = await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "PROJECTED" });
    return store.publicStatus(commandId);
  } catch (error) {
    if (["SIGNED", "SUBMITTED", "CONFIRMED"].includes(command.state.status)) {
      try { await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "UNKNOWN" }); } catch {}
    } else if (!["UNKNOWN", "FINALIZED", "PROJECTED", "FAILED_TERMINAL"].includes(command.state.status)) {
      try {
        await store.transition(commandId, { expectedRevision: command.state.revision, ...fence(), to: "FAILED_RETRYABLE",
          errorCode: "ATTESTATION_DISPATCH_FAILED", errorMessage: boundedFailure(error) });
      } catch {}
    }
    throw error;
  }
}
