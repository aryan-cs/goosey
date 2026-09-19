import { randomUUID } from "node:crypto";

import { Prisma, type MarketSettlementRun } from "@prisma/client";

import { settlementPayoutMilli, voidPayoutMilli } from "@/lib/market-maker";
import { ApiError, consumeRateLimit, prisma } from "@/lib/market-service";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { formatFeathers } from "@/lib/view-models";

const MAX_BATCH_SIZE = 100;
const DEFAULT_LEASE_MS = 30_000;
const TREASURY_OWNER_ID = "treasury";
const TREASURY_PURPOSE = "TREASURY";

async function requireActiveSettlementOperator(tx: Prisma.TransactionClient, actorUserId: string): Promise<void> {
  const actor = await tx.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, status: true },
  });
  if (!actor || !["ADMIN", "SYSTEM"].includes(actor.role) || actor.status !== "ACTIVE") {
    throw new ApiError(403, "SETTLEMENT_OPERATOR_REQUIRED", "An active settlement operator is required.");
  }
}

async function userWallet(tx: Prisma.TransactionClient, userId: string, balanceMilli: bigint) {
  const canonical = await tx.ledgerAccount.findUnique({
    where: {
      ownerType_ownerId_purpose: { ownerType: "USER", ownerId: userId, purpose: "USER_FEATHERS" },
    },
  });
  if (canonical) {
    if (canonical.status !== "ACTIVE" || canonical.balanceMilli !== balanceMilli) {
      throw new ApiError(409, "WALLET_STATE_MISMATCH", "The participant wallet requires reconciliation before settlement.");
    }
    return canonical;
  }
  const legacy = await tx.ledgerAccount.findUnique({
    where: {
      ownerType_ownerId_purpose: { ownerType: "USER", ownerId: userId, purpose: "FEATHERS" },
    },
  });
  if (legacy) {
    if (legacy.status !== "ACTIVE" || legacy.balanceMilli !== balanceMilli) {
      throw new ApiError(409, "WALLET_STATE_MISMATCH", "The participant wallet requires reconciliation before settlement.");
    }
    return tx.ledgerAccount.update({ where: { id: legacy.id }, data: { purpose: "USER_FEATHERS" } });
  }
  return tx.ledgerAccount.create({
    data: { ownerType: "USER", ownerId: userId, purpose: "USER_FEATHERS", balanceMilli },
  });
}

async function treasuryAccount(tx: Prisma.TransactionClient) {
  return tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: TREASURY_OWNER_ID,
        purpose: TREASURY_PURPOSE,
      },
    },
    create: {
      ownerType: "SYSTEM",
      ownerId: TREASURY_OWNER_ID,
      purpose: TREASURY_PURPOSE,
      allowsNegative: true,
    },
    update: {},
  });
}

function payoutFor(
  position: { yesShares: number; noShares: number },
  outcome: string,
  payoutMilli: bigint,
): bigint {
  if (outcome === "YES") return settlementPayoutMilli(position.yesShares, payoutMilli);
  if (outcome === "NO") return settlementPayoutMilli(position.noShares, payoutMilli);
  if (outcome === "VOID") return voidPayoutMilli(position.yesShares + position.noShares, payoutMilli);
  throw new Error(`Unsupported settlement outcome ${outcome}`);
}

function publicRun(run: MarketSettlementRun) {
  return {
    id: run.id,
    marketId: run.marketId,
    proposalId: run.proposalId,
    outcome: run.outcome,
    status: run.status,
    cursorPositionId: run.cursorPositionId,
    totalPositions: run.totalPositions,
    processedCount: run.processedCount,
    totalPayoutMilli: run.totalPayoutMilli,
    batchCount: run.batchCount,
    lastError: run.lastError,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export async function claimSettlementRun(input: {
  actorUserId: string;
  runId: string;
  leaseMs?: number;
}) {
  const leaseMs = Math.max(5_000, Math.min(input.leaseMs ?? DEFAULT_LEASE_MS, 120_000));
  const operationAt = new Date();
  const claimToken = randomUUID();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveSettlementOperator(tx, input.actorUserId);
    const run = await tx.marketSettlementRun.findUnique({ where: { id: input.runId } });
    if (!run) throw new ApiError(404, "SETTLEMENT_RUN_NOT_FOUND", "Settlement run not found.");
    if (run.status === "COMPLETED") return { run: publicRun(run), claimToken: null, replayed: true };
    if (!["READY", "RUNNING", "FINALIZING"].includes(run.status)) {
      throw new ApiError(409, "SETTLEMENT_RUN_UNAVAILABLE", "Settlement run is not available for processing.");
    }

    const claimed = await tx.marketSettlementRun.updateMany({
      where: {
        id: run.id,
        status: { in: ["READY", "RUNNING", "FINALIZING"] },
        OR: [{ claimToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: operationAt } }],
      },
      data: {
        claimToken,
        leaseExpiresAt: new Date(operationAt.getTime() + leaseMs),
        status: run.status === "FINALIZING" ? "FINALIZING" : "RUNNING",
        startedAt: run.startedAt ?? operationAt,
        lastError: null,
      },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "SETTLEMENT_RUN_BUSY", "Another worker currently owns this settlement run.");
    }
    const updated = await tx.marketSettlementRun.findUniqueOrThrow({ where: { id: run.id } });
    return { run: publicRun(updated), claimToken, replayed: false };
  });
}

export async function processClaimedBatch(input: {
  actorUserId: string;
  runId: string;
  claimToken: string;
  batchSize: number;
}) {
  const operationAt = new Date();
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveSettlementOperator(tx, input.actorUserId);
    const run = await tx.marketSettlementRun.findUnique({
      where: { id: input.runId },
      include: { market: { include: { collateralAccount: true } } },
    });
    if (!run) throw new ApiError(404, "SETTLEMENT_RUN_NOT_FOUND", "Settlement run not found.");
    if (
      run.claimToken !== input.claimToken ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= operationAt ||
      run.status !== "RUNNING"
    ) {
      throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement worker lease is no longer valid.");
    }
    if (run.market.status !== "RESOLVING" || run.market.resolution !== run.outcome) {
      throw new ApiError(409, "SETTLEMENT_STATE_MISMATCH", "The market no longer matches its approved outcome.");
    }
    if (run.market.pricingModel === "ORDER_BOOK") {
      const [liveOrders, liveReservations, reservedPositions] = await Promise.all([
        tx.marketOrder.count({
          where: {
            marketId: run.marketId,
            status: { in: ["OPEN", "PARTIALLY_FILLED"] },
            remainingQuantity: { gt: 0 },
          },
        }),
        tx.orderReservation.count({
          where: {
            marketId: run.marketId,
            OR: [
              { reservedPrincipalMilli: { gt: 0n } },
              { reservedFeeMilli: { gt: 0n } },
              { reservedYesQuantity: { gt: 0 } },
              { reservedNoQuantity: { gt: 0 } },
            ],
          },
        }),
        tx.position.count({
          where: {
            marketId: run.marketId,
            OR: [{ reservedYesShares: { gt: 0 } }, { reservedNoShares: { gt: 0 } }],
          },
        }),
      ]);
      if (liveOrders > 0 || liveReservations > 0 || reservedPositions > 0) {
        throw new ApiError(409, "ORDER_BOOK_NOT_DRAINED", "The order book must be fully drained before settlement.");
      }
    }

    const positions = await tx.position.findMany({
      where: {
        marketId: run.marketId,
        OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
        ...(run.cursorPositionId ? { id: { gt: run.cursorPositionId } } : {}),
      },
      include: { user: true },
      orderBy: { id: "asc" },
      take: input.batchSize,
    });
    if (positions.length === 0) {
      const transitioned = await tx.marketSettlementRun.updateMany({
        where: {
          id: run.id,
          status: "RUNNING",
          claimToken: input.claimToken,
          leaseExpiresAt: { gt: operationAt },
        },
        data: { status: "FINALIZING" },
      });
      if (transitioned.count !== 1) {
        throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement worker lost its lease before advancing progress.");
      }
      const finalizing = await tx.marketSettlementRun.findUniqueOrThrow({ where: { id: run.id } });
      return { run: publicRun(finalizing), processedThisBatch: 0, shouldFinalize: true };
    }

    let batchPayoutMilli = 0n;
    for (const position of positions) {
      const payoutMilli = payoutFor(position, run.outcome, run.market.payoutMilli);
      batchPayoutMilli += payoutMilli;
    }
    if (batchPayoutMilli > run.market.collateralAccount.balanceMilli) {
      throw new ApiError(409, "MARKET_UNDERCOLLATERALIZED", "Market collateral cannot cover this settlement batch.");
    }

    for (const position of positions) {
      const payoutMilli = payoutFor(position, run.outcome, run.market.payoutMilli);
      const realizedDelta = payoutMilli - position.netCostMilli;
      let journalEntryId: string | undefined;
      if (payoutMilli > 0n) {
        const wallet = await userWallet(tx, position.userId, position.user.balanceMilli);
        const journal = await tx.journalEntry.create({
          data: {
            type: run.outcome === "VOID" ? "VOID_SETTLEMENT" : "SETTLEMENT",
            referenceType: "POSITION",
            referenceId: position.id,
            idempotencyScope: `MARKET_SETTLEMENT:${run.marketId}`,
            idempotencyKey: position.userId,
            actorUserId: input.actorUserId,
            metadata: jsonStringify({
              settlementRunId: run.id,
              marketId: run.marketId,
              outcome: run.outcome,
              payoutMilli,
              realizedDelta,
            }),
            postings: {
              create: [
                { ledgerAccountId: run.market.collateralAccountId, amountMilli: -payoutMilli },
                { ledgerAccountId: wallet.id, amountMilli: payoutMilli },
              ],
            },
          },
        });
        journalEntryId = journal.id;
        await Promise.all([
          tx.ledgerAccount.update({ where: { id: wallet.id }, data: { balanceMilli: { increment: payoutMilli } } }),
          tx.user.update({
            where: { id: position.userId },
            data: { balanceMilli: { increment: payoutMilli }, realizedPnlMilli: { increment: realizedDelta } },
          }),
        ]);
      } else {
        await tx.user.update({
          where: { id: position.userId },
          data: { realizedPnlMilli: { increment: realizedDelta } },
        });
      }
      await tx.position.update({
        where: { id: position.id },
        data: {
          yesShares: 0,
          noShares: 0,
          netCostMilli: 0n,
          yesCostBasisMilli: 0n,
          noCostBasisMilli: 0n,
          realizedPnlMilli: { increment: realizedDelta },
        },
      });
      const settlement = await tx.positionSettlement.create({
        data: {
          marketId: run.marketId,
          userId: position.userId,
          payoutMilli,
          journalEntryId,
          settlementRunId: run.id,
        },
      });
      await Promise.all([
        tx.notification.create({
          data: {
            userId: position.userId,
            type: "MARKET_RESOLVED",
            title: `Market resolved ${run.outcome}`,
            body: `Your position settled for ${formatFeathers(payoutMilli)} feathers.`,
            href: `/markets/${run.market.slug}`,
          },
        }),
        tx.auditLog.create({
          data: {
            actorUserId: input.actorUserId,
            action: "POSITION_SETTLED",
            entityType: "POSITION_SETTLEMENT",
            entityId: settlement.id,
            metadata: jsonStringify({
              settlementRunId: run.id,
              marketId: run.marketId,
              userId: position.userId,
              payoutMilli,
            }),
          },
        }),
      ]);
    }

    if (batchPayoutMilli > 0n) {
      const debited = await tx.ledgerAccount.updateMany({
        where: { id: run.market.collateralAccountId, balanceMilli: { gte: batchPayoutMilli } },
        data: { balanceMilli: { decrement: batchPayoutMilli } },
      });
      if (debited.count !== 1) {
        throw new ApiError(409, "MARKET_UNDERCOLLATERALIZED", "Market collateral cannot cover this settlement batch.");
      }
    }

    const lastPositionId = positions.at(-1)!.id;
    const remaining = await tx.position.findFirst({
      where: {
        marketId: run.marketId,
        id: { gt: lastPositionId },
        OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const advanced = await tx.marketSettlementRun.updateMany({
      where: {
        id: run.id,
        status: "RUNNING",
        claimToken: input.claimToken,
        leaseExpiresAt: { gt: operationAt },
      },
      data: {
        cursorPositionId: lastPositionId,
        processedCount: { increment: positions.length },
        totalPayoutMilli: { increment: batchPayoutMilli },
        batchCount: { increment: 1 },
        status: remaining ? "READY" : "FINALIZING",
        claimToken: remaining ? null : input.claimToken,
        leaseExpiresAt: remaining ? null : run.leaseExpiresAt,
      },
    });
    if (advanced.count !== 1) {
      throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement worker lost its lease before advancing progress.");
    }
    const updated = await tx.marketSettlementRun.findUniqueOrThrow({ where: { id: run.id } });
    return {
      run: publicRun(updated),
      processedThisBatch: positions.length,
      shouldFinalize: !remaining,
    };
  });
}

async function finalizeClaimedRun(input: { actorUserId: string; runId: string; claimToken: string }) {
  const operationAt = new Date();
  const extendedLeaseAt = new Date(operationAt.getTime() + 120_000);
  return runSerializableTransaction(prisma, async (tx) => {
    await requireActiveSettlementOperator(tx, input.actorUserId);
    const run = await tx.marketSettlementRun.findUnique({
      where: { id: input.runId },
      include: { market: { include: { collateralAccount: true } } },
    });
    if (!run) throw new ApiError(404, "SETTLEMENT_RUN_NOT_FOUND", "Settlement run not found.");
    if (run.status === "COMPLETED") return { run: publicRun(run), replayed: true };
    if (
      run.status !== "FINALIZING" ||
      run.claimToken !== input.claimToken ||
      !run.leaseExpiresAt ||
      run.leaseExpiresAt <= operationAt
    ) {
      throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement finalization lease is no longer valid.");
    }
    const fenced = await tx.marketSettlementRun.updateMany({
      where: {
        id: run.id,
        status: "FINALIZING",
        claimToken: input.claimToken,
        leaseExpiresAt: { gt: operationAt },
      },
      data: { leaseExpiresAt: extendedLeaseAt },
    });
    if (fenced.count !== 1) {
      throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement finalizer could not renew its lease.");
    }

    const [activePositionCount, settlementCount, payout, liveOrders, liveReservations, reservedPositions] = await Promise.all([
      tx.position.count({
        where: {
          marketId: run.marketId,
          OR: [{ yesShares: { gt: 0 } }, { noShares: { gt: 0 } }],
        },
      }),
      tx.positionSettlement.count({ where: { settlementRunId: run.id } }),
      tx.positionSettlement.aggregate({ where: { settlementRunId: run.id }, _sum: { payoutMilli: true } }),
      run.market.pricingModel === "ORDER_BOOK"
        ? tx.marketOrder.count({
            where: { marketId: run.marketId, status: { in: ["OPEN", "PARTIALLY_FILLED"] }, remainingQuantity: { gt: 0 } },
          })
        : Promise.resolve(0),
      run.market.pricingModel === "ORDER_BOOK"
        ? tx.orderReservation.count({
            where: {
              marketId: run.marketId,
              OR: [
                { reservedPrincipalMilli: { gt: 0n } },
                { reservedFeeMilli: { gt: 0n } },
                { reservedYesQuantity: { gt: 0 } },
                { reservedNoQuantity: { gt: 0 } },
              ],
            },
          })
        : Promise.resolve(0),
      run.market.pricingModel === "ORDER_BOOK"
        ? tx.position.count({
            where: { marketId: run.marketId, OR: [{ reservedYesShares: { gt: 0 } }, { reservedNoShares: { gt: 0 } }] },
          })
        : Promise.resolve(0),
    ]);
    const totalPayoutMilli = payout._sum.payoutMilli ?? 0n;
    if (
      activePositionCount !== 0 ||
      liveOrders !== 0 ||
      liveReservations !== 0 ||
      reservedPositions !== 0 ||
      settlementCount !== run.totalPositions ||
      run.processedCount !== run.totalPositions ||
      totalPayoutMilli !== run.totalPayoutMilli
    ) {
      throw new ApiError(409, "SETTLEMENT_INCOMPLETE", "Settlement accounting is incomplete and cannot be finalized.");
    }

    const collateralReturnMilli = run.market.collateralAccount.balanceMilli;
    if (collateralReturnMilli > 0n) {
      const treasury = await treasuryAccount(tx);
      await tx.journalEntry.create({
        data: {
          type: "COLLATERAL_RETURN",
          referenceType: "MARKET",
          referenceId: run.marketId,
          idempotencyScope: `MARKET_COLLATERAL_RETURN:${run.marketId}`,
          idempotencyKey: run.outcome,
          actorUserId: input.actorUserId,
          metadata: jsonStringify({ settlementRunId: run.id, amountMilli: collateralReturnMilli }),
          postings: {
            create: [
              { ledgerAccountId: run.market.collateralAccountId, amountMilli: -collateralReturnMilli },
              { ledgerAccountId: treasury.id, amountMilli: collateralReturnMilli },
            ],
          },
        },
      });
      await tx.ledgerAccount.update({
        where: { id: treasury.id },
        data: { balanceMilli: { increment: collateralReturnMilli } },
      });
    }
    await tx.ledgerAccount.update({
      where: { id: run.market.collateralAccountId },
      data: { balanceMilli: 0n, status: "CLOSED" },
    });

    const resolvedAt = operationAt;
    const terminalStatus = run.outcome === "VOID" ? "VOID" : "RESOLVED";
    const terminal = await tx.market.updateMany({
      where: { id: run.marketId, status: "RESOLVING", resolution: run.outcome },
      data: {
        status: terminalStatus,
        resolvedAt,
        yesShares: 0,
        noShares: 0,
        version: { increment: 1 },
      },
    });
    if (terminal.count !== 1) {
      throw new ApiError(409, "SETTLEMENT_STATE_MISMATCH", "The market could not be finalized from its resolving state.");
    }
    await Promise.all([
      tx.marketPriceSnapshot.create({
        data: {
          marketId: run.marketId,
          yesProbabilityBps: run.outcome === "YES" ? 10_000 : run.outcome === "NO" ? 0 : 5_000,
          createdAt: resolvedAt,
        },
      }),
      tx.auditLog.create({
        data: {
          actorUserId: input.actorUserId,
          action: "MARKET_RESOLVED",
          entityType: "MARKET",
          entityId: run.marketId,
          metadata: jsonStringify({
            settlementRunId: run.id,
            outcome: run.outcome,
            reason: run.reason,
            evidence: run.evidence,
            settlementCount,
            totalPayoutMilli,
          }),
        },
      }),
    ]);
    const completedWrite = await tx.marketSettlementRun.updateMany({
      where: {
        id: run.id,
        status: "FINALIZING",
        claimToken: input.claimToken,
        leaseExpiresAt: { gt: operationAt },
      },
      data: {
        status: "COMPLETED",
        claimToken: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: resolvedAt,
      },
    });
    if (completedWrite.count !== 1) {
      throw new ApiError(409, "SETTLEMENT_CLAIM_LOST", "The settlement finalizer lost its lease before completion.");
    }
    const completed = await tx.marketSettlementRun.findUniqueOrThrow({ where: { id: run.id } });
    return { run: publicRun(completed), replayed: false };
  });
}

async function releaseFailedClaim(runId: string, claimToken: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : "Unknown settlement worker failure";
  const run = await prisma.marketSettlementRun.findUnique({ where: { id: runId }, select: { status: true } });
  if (!run || run.status === "COMPLETED") return;
  await prisma.marketSettlementRun.updateMany({
    where: { id: runId, claimToken },
    data: {
      status: run.status === "FINALIZING" ? "FINALIZING" : "READY",
      claimToken: null,
      leaseExpiresAt: null,
      lastError: message,
    },
  });
}

export async function processSettlementRun(input: {
  actorUserId: string;
  runId: string;
  batchSize?: number;
}) {
  const batchSize = input.batchSize ?? MAX_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new ApiError(400, "INVALID_BATCH_SIZE", `Settlement batches must contain 1–${MAX_BATCH_SIZE} positions.`);
  }
  await consumeRateLimit(prisma, `admin-settlement-run:${input.actorUserId}`, 120, 60_000);
  const claim = await claimSettlementRun({ actorUserId: input.actorUserId, runId: input.runId });
  if (!claim.claimToken) return { ...claim, processedThisBatch: 0 };
  try {
    if (claim.run.status === "FINALIZING") {
      const final = await finalizeClaimedRun({ ...input, claimToken: claim.claimToken });
      return { ...final, processedThisBatch: 0 };
    }
    const batch = await processClaimedBatch({ ...input, batchSize, claimToken: claim.claimToken });
    if (!batch.shouldFinalize) return { ...batch, replayed: false };
    const final = await finalizeClaimedRun({ ...input, claimToken: claim.claimToken });
    return { ...final, processedThisBatch: batch.processedThisBatch };
  } catch (error) {
    await releaseFailedClaim(input.runId, claim.claimToken, error).catch(() => undefined);
    throw error;
  }
}

export async function getSettlementRun(runId: string) {
  const run = await prisma.marketSettlementRun.findUnique({ where: { id: runId } });
  if (!run) throw new ApiError(404, "SETTLEMENT_RUN_NOT_FOUND", "Settlement run not found.");
  return publicRun(run);
}

export { MAX_BATCH_SIZE };
