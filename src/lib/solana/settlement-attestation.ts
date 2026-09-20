import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { acceptChainCommand, canonicalChainCommandJson } from "@/lib/solana/chain-command";
import type { SolanaRuntime } from "@/lib/solana/runtime";

export const SETTLEMENT_ATTESTATION_OPERATION = "ATTEST_DATABASE_SETTLEMENT";
export const SETTLEMENT_ATTESTATION_IDEMPOTENCY_KEY = "settlement:v1";

const SHA256 = /^[a-f0-9]{64}$/;
const U64_MAX = (1n << 64n) - 1n;

export type SettlementAttestationRow = Readonly<{
  id: string;
  userId: string;
  payoutMilli: bigint;
  journalEntryId: string | null;
}>;

export type SettlementAttestationInput = Readonly<{
  runtime: Pick<SolanaRuntime, "cluster" | "genesisHash" | "programAddress">;
  databaseDomainHex: string;
  actorUserId: string;
  marketId: string;
  settlementRunId: string;
  proposalId: string;
  outcome: "YES" | "NO" | "VOID";
  approvalRequestHash: string;
  reason: string;
  evidence: string;
  totalPositions: number;
  processedCount: number;
  settlementCount: number;
  totalPayoutMilli: bigint;
  collateralReturnMilli: bigint;
  resolvedAt: Date;
  settlements: readonly SettlementAttestationRow[];
}>;

export type CanonicalSettlementAttestation = Readonly<{
  marketDigest: string;
  settlementDigest: string;
  request: Readonly<{
    schema: "goosey.database-settlement-attestation";
    version: 1;
    marketDigest: string;
    settlementDigest: string;
    outcome: "YES" | "NO" | "VOID";
    resolvedAt: string;
    resolvedAtUnixSeconds: string;
    settlementCount: number;
    totalPayoutMilli: string;
  }>;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedU64(value: bigint, label: string): string {
  if (value < 0n || value > U64_MAX) throw new Error(`${label} is outside the Solana u64 range`);
  return value.toString();
}

function boundedCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || BigInt(value) > U64_MAX) {
    throw new Error(`${label} is outside the Solana u64 range`);
  }
  return value;
}

function canonicalSettlementRoot(rows: readonly SettlementAttestationRow[]): string {
  const ordered = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  if (ordered.some((row, index) => index > 0 && row.id === ordered[index - 1].id)) {
    throw new Error("Settlement attestation rows contain a duplicate id");
  }
  return sha256(canonicalChainCommandJson(ordered.map(row => ({
    id: row.id,
    userId: row.userId,
    payoutMilli: boundedU64(row.payoutMilli, "Settlement payout"),
    journalEntryId: row.journalEntryId,
  }))));
}

/** Builds the exact public commitment. Raw evidence and participant identifiers
 * remain off-chain; only their canonical aggregate digest is submitted. */
export function canonicalSettlementAttestation(input: SettlementAttestationInput): CanonicalSettlementAttestation {
  if (!SHA256.test(input.approvalRequestHash)) throw new Error("Invalid settlement approval request hash");
  if (!SHA256.test(input.databaseDomainHex) || /^0+$/.test(input.databaseDomainHex)) {
    throw new Error("Invalid settlement database domain");
  }
  if (!Number.isFinite(input.resolvedAt.getTime())) throw new Error("Invalid settlement resolution time");
  const resolvedAtUnixSeconds = BigInt(Math.floor(input.resolvedAt.getTime() / 1_000));
  if (resolvedAtUnixSeconds < 0n || resolvedAtUnixSeconds > (1n << 63n) - 1n) {
    throw new Error("Settlement resolution time is outside the Solana i64 range");
  }
  const totalPositions = boundedCount(input.totalPositions, "Total positions");
  const processedCount = boundedCount(input.processedCount, "Processed positions");
  const settlementCount = boundedCount(input.settlementCount, "Settlement count");
  if (totalPositions !== processedCount || processedCount !== settlementCount || settlementCount !== input.settlements.length) {
    throw new Error("Settlement counts do not agree");
  }
  const marketDigest = sha256(canonicalChainCommandJson({
    domain: "goosey.database-market.v1",
    databaseDomainHex: input.databaseDomainHex,
    cluster: input.runtime.cluster,
    genesisHash: input.runtime.genesisHash,
    programAddress: input.runtime.programAddress.toString(),
    marketId: input.marketId,
  }));
  const payload = {
    domain: "goosey.database-settlement.v1",
    marketId: input.marketId,
    marketDigest,
    settlementRunId: input.settlementRunId,
    proposalId: input.proposalId,
    outcome: input.outcome,
    approvalRequestHash: input.approvalRequestHash,
    reasonDigest: sha256(input.reason),
    evidenceDigest: sha256(input.evidence),
    totalPositions,
    processedCount,
    settlementCount,
    totalPayoutMilli: boundedU64(input.totalPayoutMilli, "Total payout"),
    collateralReturnMilli: boundedU64(input.collateralReturnMilli, "Collateral return"),
    resolvedAt: input.resolvedAt.toISOString(),
    resolvedAtUnixSeconds: resolvedAtUnixSeconds.toString(),
    settlementRoot: canonicalSettlementRoot(input.settlements),
  } as const;
  const settlementDigest = sha256(canonicalChainCommandJson(payload));
  return Object.freeze({
    marketDigest,
    settlementDigest,
    request: Object.freeze({
      schema: "goosey.database-settlement-attestation",
      version: 1,
      marketDigest,
      settlementDigest,
      outcome: input.outcome,
      resolvedAt: payload.resolvedAt,
      resolvedAtUnixSeconds: payload.resolvedAtUnixSeconds,
      settlementCount,
      totalPayoutMilli: payload.totalPayoutMilli,
    }),
  });
}

export function settlementAttestationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GOOSEY_SOLANA_SETTLEMENT_ATTESTATION_ENABLED === "true";
}

export function resolveSettlementDatabaseDomain(env: Record<string, string | undefined> = process.env): string {
  const value = env.GOOSEY_SOLANA_DATABASE_DOMAIN ?? "";
  if (!SHA256.test(value) || /^0+$/.test(value)) {
    throw new Error("GOOSEY_SOLANA_DATABASE_DOMAIN must be a nonzero 32-byte lowercase hex digest");
  }
  return value;
}

/** Creates the command and receipt shell inside the caller's settlement
 * transaction. RPC submission is deliberately left to the worker. */
export async function createSettlementAttestationIntent(
  tx: Prisma.TransactionClient,
  input: SettlementAttestationInput,
) {
  const canonical = canonicalSettlementAttestation(input);
  const identity = acceptChainCommand({
    runtime: input.runtime,
    scope: "MARKET",
    scopeId: input.marketId,
    actorId: input.actorUserId,
    operation: SETTLEMENT_ATTESTATION_OPERATION,
    idempotencyKey: SETTLEMENT_ATTESTATION_IDEMPOTENCY_KEY,
    request: canonical.request,
  });
  const existing = await tx.marketSettlementAttestation.findUnique({
    where: { settlementRunId: input.settlementRunId },
    include: { command: true },
  });
  if (existing) {
    if (existing.digest !== canonical.settlementDigest || existing.marketDigest !== canonical.marketDigest
      || existing.command.requestHash !== identity.requestHash || existing.command.requestJson !== identity.requestJson
      || existing.command.operation !== identity.operation || existing.command.actorId !== identity.actorId) {
      throw new Error("Settlement attestation replay changed immutable intent");
    }
    return existing;
  }
  const command = await tx.chainCommand.create({ data: identity });
  return tx.marketSettlementAttestation.create({
    data: {
      settlementRunId: input.settlementRunId,
      commandId: command.id,
      digest: canonical.settlementDigest,
      marketDigest: canonical.marketDigest,
    },
    include: { command: true },
  });
}
