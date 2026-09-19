import type { NextRequest } from "next/server";
import { assertDatabaseFinancialMarket, DATABASE_MARKET_FILTER } from "./market-backend";
import { assertMutationSession } from "@/lib/mutation-session";
import { createHash } from "node:crypto";

import { Prisma, type Market, type Position } from "@prisma/client";
import { z } from "zod";

import { requiresEmailVerification } from "@/lib/auth";
import { assertBalancedJournal } from "@/lib/invariants";
import { requiredCollateralMilli } from "@/lib/market-maker";
import { ApiError, consumeRateLimit, principalScopedIdempotencyScope, prisma } from "@/lib/market-service";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { formatFeathers } from "@/lib/view-models";

const MAX_REDEMPTION_QUANTITY = 10_000_000;

export const redemptionRequestSchema = z
  .object({
    quantity: z.number().int().min(1).max(MAX_REDEMPTION_QUANTITY),
    marketVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RedemptionRequest = z.infer<typeof redemptionRequestSchema>;

export function redemptionRequestHash(input: RedemptionRequest): string {
  return createHash("sha256").update(jsonStringify(input)).digest("hex");
}

export interface RedemptionAccounting {
  payoutMilli: bigint;
  yesBasisRemovedMilli: bigint;
  noBasisRemovedMilli: bigint;
  totalBasisRemovedMilli: bigint;
  realizedPnlDeltaMilli: bigint;
  yesSharesAfter: number;
  noSharesAfter: number;
  yesCostBasisAfterMilli: bigint;
  noCostBasisAfterMilli: bigint;
  netCostAfterMilli: bigint;
}

export function availableCompleteSets(
  position: Pick<Position, "yesShares" | "noShares" | "reservedYesShares" | "reservedNoShares">,
): number {
  if (
    position.reservedYesShares < 0 ||
    position.reservedNoShares < 0 ||
    position.reservedYesShares > position.yesShares ||
    position.reservedNoShares > position.noShares
  ) {
    throw new RangeError("Position reservations require reconciliation.");
  }

  return Math.min(
    position.yesShares - position.reservedYesShares,
    position.noShares - position.reservedNoShares,
  );
}

export function computeRedemptionAccounting(
  position: Pick<Position, "yesShares" | "noShares" | "yesCostBasisMilli" | "noCostBasisMilli" | "netCostMilli">,
  payoutMilli: bigint,
  quantity: number,
): RedemptionAccounting {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_REDEMPTION_QUANTITY) {
    throw new RangeError("Redemption quantity must be a supported positive integer.");
  }
  if (payoutMilli <= 0n) throw new RangeError("Market payout must be positive.");
  if (position.yesShares < quantity || position.noShares < quantity) {
    throw new RangeError("A complete set requires an equal YES and NO contract.");
  }
  if (
    position.yesCostBasisMilli < 0n ||
    position.noCostBasisMilli < 0n ||
    position.netCostMilli !== position.yesCostBasisMilli + position.noCostBasisMilli
  ) {
    throw new RangeError("Position cost basis requires reconciliation.");
  }

  const yesBasisRemovedMilli =
    quantity === position.yesShares
      ? position.yesCostBasisMilli
      : (position.yesCostBasisMilli * BigInt(quantity)) / BigInt(position.yesShares);
  const noBasisRemovedMilli =
    quantity === position.noShares
      ? position.noCostBasisMilli
      : (position.noCostBasisMilli * BigInt(quantity)) / BigInt(position.noShares);
  const totalBasisRemovedMilli = yesBasisRemovedMilli + noBasisRemovedMilli;
  const payout = BigInt(quantity) * payoutMilli;

  return {
    payoutMilli: payout,
    yesBasisRemovedMilli,
    noBasisRemovedMilli,
    totalBasisRemovedMilli,
    realizedPnlDeltaMilli: payout - totalBasisRemovedMilli,
    yesSharesAfter: position.yesShares - quantity,
    noSharesAfter: position.noShares - quantity,
    yesCostBasisAfterMilli: position.yesCostBasisMilli - yesBasisRemovedMilli,
    noCostBasisAfterMilli: position.noCostBasisMilli - noBasisRemovedMilli,
    netCostAfterMilli: position.netCostMilli - totalBasisRemovedMilli,
  };
}

async function ensureUserLedgerAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  balanceMilli: bigint,
) {
  return tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "USER",
        ownerId: userId,
        purpose: "USER_FEATHERS",
      },
    },
    create: {
      ownerType: "USER",
      ownerId: userId,
      purpose: "USER_FEATHERS",
      balanceMilli,
    },
    update: {},
  });
}

function assertRedeemableMarket(market: Pick<Market, "status" | "resolution">): void {
  if ((market.status !== "OPEN" && market.status !== "CLOSED") || market.resolution !== null) {
    throw new ApiError(
      422,
      "MARKET_NOT_REDEEMABLE",
      "Complete sets can only be redeemed before an open or closed market resolves.",
    );
  }
}

export async function redeemCompleteSet(input: {
  userId: string;
  authRequest?: NextRequest;
  marketId: string;
  quantity: number;
  marketVersion: number;
  idempotencyKey: string;
}) {
  const request = redemptionRequestSchema.parse({
    quantity: input.quantity,
    marketVersion: input.marketVersion,
  });
  await consumeRateLimit(prisma, `redeem:${input.userId}`, 20, 60_000);
  const operationAt = new Date();
  const idempotencyExpiresAt = new Date(operationAt.getTime() + 24 * 60 * 60 * 1_000);

  const route = `/api/markets/${input.marketId}/redeem`;
  const journalScope = principalScopedIdempotencyScope(route, input.userId);
  const requestHash = redemptionRequestHash(request);

  return runSerializableTransaction(
    prisma,
    async (tx) => {
      if (input.authRequest) await assertMutationSession(tx, input.authRequest, input.userId);
      const existingRequest = await tx.idempotencyRequest.findUnique({
        where: { userId_route_key: { userId: input.userId, route, key: input.idempotencyKey } },
      });
      if (existingRequest) {
        if (existingRequest.requestHash !== requestHash) {
          throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another request.");
        }
        if (existingRequest.status === "COMPLETED" && existingRequest.responseBody) {
          return JSON.parse(existingRequest.responseBody) as unknown;
        }
        throw new ApiError(409, "REQUEST_IN_PROGRESS", "This redemption is already being processed.");
      }

      const idempotencyRequest = await tx.idempotencyRequest.create({
        data: {
          userId: input.userId,
          route,
          key: input.idempotencyKey,
          requestHash,
          expiresAt: idempotencyExpiresAt,
        },
      });

      const [user, market, position] = await Promise.all([
        tx.user.findUnique({ where: { id: input.userId } }),
        tx.market.findUnique({
          where: { id: input.marketId },
          include: { collateralAccount: true },
        }),
        tx.position.findUnique({
          where: { userId_marketId: { userId: input.userId, marketId: input.marketId } },
        }),
      ]);

      if (!user || user.status !== "ACTIVE") {
        throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
      }
      if (user.role !== "USER") {
        throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot redeem positions.");
      }
      if (requiresEmailVerification(user)) {
        throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before redeeming positions.");
      }
      if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      assertDatabaseFinancialMarket(market);
      assertRedeemableMarket(market);
      if (market.version !== request.marketVersion) {
        throw new ApiError(409, "STALE_MARKET", "The market changed. Refresh before redeeming.", {
          currentVersion: market.version,
        });
      }
      if (!position) {
        throw new ApiError(
          422,
          "INSUFFICIENT_COMPLETE_SETS",
          "You do not hold enough matching YES and NO contracts.",
        );
      }
      let redeemableQuantity: number;
      try {
        redeemableQuantity = availableCompleteSets(position);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiError(409, "POSITION_RECONCILIATION_REQUIRED", error.message);
        }
        throw error;
      }
      if (redeemableQuantity < request.quantity) {
        throw new ApiError(
          422,
          "INSUFFICIENT_COMPLETE_SETS",
          "You do not hold enough unreserved matching YES and NO contracts.",
          { availableQuantity: redeemableQuantity },
        );
      }
      if (market.yesShares < request.quantity || market.noShares < request.quantity) {
        throw new ApiError(409, "MARKET_RECONCILIATION_REQUIRED", "Market quantities require reconciliation.");
      }

      let accounting: RedemptionAccounting;
      try {
        accounting = computeRedemptionAccounting(position, market.payoutMilli, request.quantity);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ApiError(409, "POSITION_RECONCILIATION_REQUIRED", error.message);
        }
        throw error;
      }

      const collateralAfter = market.collateralAccount.balanceMilli - accounting.payoutMilli;
      const requiredCollateralAfter = requiredCollateralMilli({
        yesQuantity: market.yesShares - request.quantity,
        noQuantity: market.noShares - request.quantity,
        liquidity: market.liquidityParameter,
        payoutMilli: market.payoutMilli,
      });
      if (collateralAfter < requiredCollateralAfter) {
        throw new ApiError(409, "MARKET_UNDERCOLLATERALIZED", "Market collateral cannot fund this redemption.");
      }

      const userAccount = await ensureUserLedgerAccount(tx, user.id, user.balanceMilli);
      if (userAccount.balanceMilli !== user.balanceMilli) {
        throw new ApiError(
          409,
          "ACCOUNT_RECONCILIATION_REQUIRED",
          "The wallet is temporarily unavailable while its ledger is reconciled.",
        );
      }

      const marketChanged = await tx.market.updateMany({
        where: {
          id: market.id,
          version: request.marketVersion,
          ...DATABASE_MARKET_FILTER,
          status: { in: ["OPEN", "CLOSED"] },
          resolution: null,
          yesShares: market.yesShares,
          noShares: market.noShares,
        },
        data: {
          yesShares: { decrement: request.quantity },
          noShares: { decrement: request.quantity },
          version: { increment: 1 },
        },
      });
      if (marketChanged.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed while redeeming this complete set.");
      }

      const positionChanged = await tx.position.updateMany({
        where: {
          id: position.id,
          yesShares: {
            equals: position.yesShares,
            gte: position.reservedYesShares + request.quantity,
          },
          noShares: {
            equals: position.noShares,
            gte: position.reservedNoShares + request.quantity,
          },
          reservedYesShares: position.reservedYesShares,
          reservedNoShares: position.reservedNoShares,
          netCostMilli: position.netCostMilli,
          yesCostBasisMilli: position.yesCostBasisMilli,
          noCostBasisMilli: position.noCostBasisMilli,
        },
        data: {
          yesShares: accounting.yesSharesAfter,
          noShares: accounting.noSharesAfter,
          netCostMilli: accounting.netCostAfterMilli,
          yesCostBasisMilli: accounting.yesCostBasisAfterMilli,
          noCostBasisMilli: accounting.noCostBasisAfterMilli,
          realizedPnlMilli: { increment: accounting.realizedPnlDeltaMilli },
        },
      });
      if (positionChanged.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "Your position changed while redeeming this complete set.");
      }

      const [userChanged, userLedgerChanged, collateralChanged] = await Promise.all([
        tx.user.updateMany({
          where: { id: user.id, status: "ACTIVE", balanceMilli: user.balanceMilli },
          data: {
            balanceMilli: { increment: accounting.payoutMilli },
            realizedPnlMilli: { increment: accounting.realizedPnlDeltaMilli },
          },
        }),
        tx.ledgerAccount.updateMany({
          where: { id: userAccount.id, status: "ACTIVE", balanceMilli: userAccount.balanceMilli },
          data: { balanceMilli: { increment: accounting.payoutMilli } },
        }),
        tx.ledgerAccount.updateMany({
          where: {
            id: market.collateralAccount.id,
            status: "ACTIVE",
            balanceMilli: market.collateralAccount.balanceMilli,
          },
          data: { balanceMilli: { decrement: accounting.payoutMilli } },
        }),
      ]);
      if (userChanged.count !== 1 || userLedgerChanged.count !== 1 || collateralChanged.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "Balances changed while redeeming this complete set.");
      }

      const postings = [
        { ledgerAccountId: userAccount.id, amountMilli: accounting.payoutMilli },
        { ledgerAccountId: market.collateralAccount.id, amountMilli: -accounting.payoutMilli },
      ];
      assertBalancedJournal(postings);
      const journal = await tx.journalEntry.create({
        data: {
          type: "REDEEM_COMPLETE_SET",
          referenceType: "COMPLETE_SET_REDEMPTION",
          referenceId: idempotencyRequest.id,
          idempotencyScope: journalScope,
          idempotencyKey: input.idempotencyKey,
          actorUserId: user.id,
          metadata: jsonStringify({
            marketId: market.id,
            quantity: request.quantity,
            payoutMilli: accounting.payoutMilli,
            basisRemovedMilli: accounting.totalBasisRemovedMilli,
            realizedPnlDeltaMilli: accounting.realizedPnlDeltaMilli,
            marketVersion: request.marketVersion,
          }),
          postings: { create: postings },
        },
      });

      await tx.notification.create({
        data: {
          userId: user.id,
          type: "COMPLETE_SET_REDEEMED",
          title: `Redeemed ${request.quantity} complete set${request.quantity === 1 ? "" : "s"}`,
          body: `${market.shortTitle} paid ${formatFeathers(accounting.payoutMilli)} feathers into your wallet.`,
          href: "/portfolio",
        },
      });

      const result = {
        redemptionId: journal.id,
        market: {
          id: market.id,
          slug: market.slug,
          version: market.version + 1,
          yesShares: market.yesShares - request.quantity,
          noShares: market.noShares - request.quantity,
        },
        position: {
          yesShares: accounting.yesSharesAfter,
          noShares: accounting.noSharesAfter,
          netCostMilli: accounting.netCostAfterMilli,
          realizedPnlMilli: position.realizedPnlMilli + accounting.realizedPnlDeltaMilli,
        },
        quantity: request.quantity,
        payoutMilli: accounting.payoutMilli,
        realizedPnlDeltaMilli: accounting.realizedPnlDeltaMilli,
        balanceMilli: user.balanceMilli + accounting.payoutMilli,
      };
      const responseBody = jsonStringify(result);
      await tx.idempotencyRequest.update({
        where: { id: idempotencyRequest.id },
        data: { status: "COMPLETED", responseCode: 201, responseBody },
      });
      return JSON.parse(responseBody) as unknown;
    },
    { timeoutMs: 10_000 },
  );
}
