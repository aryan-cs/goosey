import type { PrismaClient } from "@prisma/client";

import { db } from "@/lib/db";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";
import {
  createSettlementAttestationIntent,
  resolveSettlementDatabaseDomain,
  settlementAttestationEnabled,
} from "@/lib/solana/settlement-attestation";

function collateralReturn(postings: readonly { amountMilli: bigint }[]): bigint {
  const total = postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
  if (total !== 0n) throw new Error("Historical collateral return journal is not balanced");
  return postings.reduce((sum, posting) => posting.amountMilli > 0n ? sum + posting.amountMilli : sum, 0n);
}

/** Adds durable attestation intent to completed historical settlements without
 * changing any financial row. Safe to repeat: existing identical intents replay. */
export async function backfillSettlementAttestations(input: Readonly<{
  actorUserId: string;
  limit?: number;
  database?: PrismaClient;
  env?: Record<string, string | undefined>;
}>) {
  const database = input.database ?? db;
  const env = input.env ?? process.env;
  if (!settlementAttestationEnabled(env)) throw new Error("Solana settlement attestation is not enabled");
  const runtime = resolveSolanaRuntime(env);
  const databaseDomainHex = resolveSettlementDatabaseDomain(env);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Backfill limit must be between 1 and 1000");
  const candidates = await database.marketSettlementRun.findMany({
    where: { status: "COMPLETED", attestation: null },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    select: { id: true },
    take: limit,
  });
  let created = 0;
  for (const candidate of candidates) {
    const didCreate = await runSerializableTransaction(database, async tx => {
      const run = await tx.marketSettlementRun.findUnique({
        where: { id: candidate.id },
        include: {
          attestation: true,
          market: { select: { resolvedAt: true } },
          settlements: { orderBy: { id: "asc" }, select: { id: true, userId: true, payoutMilli: true, journalEntryId: true } },
        },
      });
      if (!run || run.status !== "COMPLETED" || run.attestation) return false;
      if (run.outcome !== "YES" && run.outcome !== "NO" && run.outcome !== "VOID") {
        throw new Error(`Settlement run ${run.id} has an invalid outcome`);
      }
      const resolvedAt = run.completedAt ?? run.market.resolvedAt;
      if (!resolvedAt) throw new Error(`Settlement run ${run.id} has no completion time`);
      const returnJournal = await tx.journalEntry.findFirst({
        where: {
          type: "COLLATERAL_RETURN",
          referenceType: "MARKET",
          referenceId: run.marketId,
          idempotencyScope: `MARKET_COLLATERAL_RETURN:${run.marketId}`,
        },
        orderBy: { createdAt: "desc" },
        select: { postings: { select: { amountMilli: true } } },
      });
      await createSettlementAttestationIntent(tx, {
        runtime,
        databaseDomainHex,
        actorUserId: input.actorUserId,
        marketId: run.marketId,
        settlementRunId: run.id,
        proposalId: run.proposalId,
        outcome: run.outcome,
        approvalRequestHash: run.approvalRequestHash,
        reason: run.reason,
        evidence: run.evidence,
        totalPositions: run.totalPositions,
        processedCount: run.processedCount,
        settlementCount: run.settlements.length,
        totalPayoutMilli: run.totalPayoutMilli,
        collateralReturnMilli: collateralReturn(returnJournal?.postings ?? []),
        resolvedAt,
        settlements: run.settlements,
      });
      return true;
    });
    if (didCreate) created += 1;
  }
  return Object.freeze({ examined: candidates.length, created, hasMore: candidates.length === limit });
}
