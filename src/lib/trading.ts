import type { NextRequest } from "next/server";
import { assertMutationSession } from "@/lib/mutation-session";
import { createHash } from "node:crypto";
import { Prisma, type Market, type Position } from "@prisma/client";
import { z } from "zod";
import { requiresEmailVerification } from "@/lib/auth";
import {
  ApiError,
  consumeRateLimit,
  principalScopedIdempotencyScope,
  prisma,
} from "@/lib/market-service";
import {
  probabilityYesBps,
  quoteTrade,
  requiredCollateralMilli,
  sellLiquidationValueMilli,
} from "@/lib/market-maker";
import { jsonStringify } from "@/lib/serializers";
import { runSerializableTransaction } from "@/lib/serializable-transaction";
import { notificationFeathers } from "@/lib/order-fill-notification";

export const sideSchema = z.enum(["YES", "NO"]);
export const actionSchema = z.enum(["BUY", "SELL"]);
const milliSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})$/, "Must be an integer milli-feather string.")
  .transform((value) => BigInt(value));

export const quoteRequestSchema = z
  .object({
    side: sideSchema.optional(),
    outcome: sideSchema.optional(),
    action: actionSchema,
    quantity: z.number().int().min(1).max(100_000),
    marketVersion: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((value) => value.side !== undefined || value.outcome !== undefined, {
    message: "Provide side or outcome.",
    path: ["side"],
  })
  .refine(
    (value) =>
      value.side === undefined || value.outcome === undefined || value.side === value.outcome,
    { message: "side and outcome must match when both are provided.", path: ["outcome"] },
  )
  .transform(({ outcome, side, ...value }) => ({
    ...value,
    side: side ?? outcome!,
  }));

export const executeTradeSchema = z
  .object({
    quoteId: z.string().cuid(),
    marketVersion: z.number().int().nonnegative().optional(),
    maxDebitMilli: milliSchema.optional(),
    minCreditMilli: milliSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Number(value.maxDebitMilli !== undefined) + Number(value.minCreditMilli !== undefined) === 1,
    { message: "Provide exactly one slippage bound." },
  );

type Side = z.infer<typeof sideSchema>;
type Action = z.infer<typeof actionSchema>;

export function availableUnreservedShares(
  position: Pick<Position, "yesShares" | "noShares" | "reservedYesShares" | "reservedNoShares"> | null,
  side: Side,
): number {
  if (!position) return 0;
  const held = side === "YES" ? position.yesShares : position.noShares;
  const reserved = side === "YES" ? position.reservedYesShares : position.reservedNoShares;
  if (held < 0 || reserved < 0 || reserved > held) {
    throw new ApiError(
      409,
      "POSITION_RECONCILIATION_REQUIRED",
      "Your position reservations require reconciliation before trading.",
    );
  }
  return held - reserved;
}

export function yesProbabilityBps(
  yesShares: number,
  noShares: number,
  liquidityParameter: number,
): number {
  return probabilityYesBps({
    yesQuantity: yesShares,
    noQuantity: noShares,
    liquidity: liquidityParameter,
  });
}

export interface ComputedQuote {
  side: Side;
  action: Action;
  quantity: number;
  grossMilli: bigint;
  feeMilli: bigint;
  totalDebitMilli?: bigint;
  netCreditMilli?: bigint;
  averagePriceMilli: bigint;
  probabilityYesBeforeBps: number;
  probabilityYesAfterBps: number;
  yesSharesAfter: number;
  noSharesAfter: number;
}

export function computeQuote(
  market: Pick<Market, "yesShares" | "noShares" | "liquidityParameter" | "payoutMilli" | "feeBps">,
  side: Side,
  action: Action,
  quantity: number,
): ComputedQuote {
  try {
    const quote = quoteTrade(
      {
        yesQuantity: market.yesShares,
        noQuantity: market.noShares,
        liquidity: market.liquidityParameter,
        payoutMilli: market.payoutMilli,
      },
      side,
      action,
      quantity,
      market.feeBps,
    );
    return {
      side,
      action,
      quantity,
      grossMilli: quote.grossMilli,
      feeMilli: quote.feeMilli,
      ...(action === "BUY" ? { totalDebitMilli: quote.totalDebitMilli } : {}),
      ...(action === "SELL" ? { netCreditMilli: quote.netCreditMilli } : {}),
      averagePriceMilli: quote.averagePriceMilli,
      probabilityYesBeforeBps: quote.probabilityYesBeforeBps,
      probabilityYesAfterBps: quote.probabilityYesAfterBps,
      yesSharesAfter: quote.stateAfter.yesQuantity,
      noSharesAfter: quote.stateAfter.noQuantity,
    };
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new ApiError(422, "INVALID_TRADE", error.message);
    }
    throw error;
  }
}

export function isLmsrMarketOpen(
  market: Pick<Market, "status" | "closesAt" | "pricingModel" | "acceptingOrders">,
  operationAt = new Date(),
): boolean {
  return market.pricingModel === "LMSR" &&
    market.status === "OPEN" &&
    market.acceptingOrders &&
    market.closesAt > operationAt;
}

export async function createTradeQuote(input: {
  userId: string;
  authRequest?: NextRequest;
  authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
  marketId: string;
  side: Side;
  action: Action;
  quantity: number;
  marketVersion?: number;
}) {
  await consumeRateLimit(prisma, `quote:${input.userId}`, 60, 60_000);
  return runSerializableTransaction(prisma, async (tx) => {
    if (input.authRequest) await assertMutationSession(tx, input.authRequest, input.userId);
    if (input.authorize) await input.authorize(tx);
    await tx.tradeQuote.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { role: true, status: true, emailVerifiedAt: true } });
    if (!user || user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
    if (user.role !== "USER") throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot trade.");
    if (requiresEmailVerification(user)) throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before trading.");
    const market = await tx.market.findUnique({ where: { id: input.marketId } });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    if (market.pricingModel !== "LMSR") {
      throw new ApiError(422, "LMSR_UNAVAILABLE", "This market does not use the LMSR trading engine.");
    }
    if (!isLmsrMarketOpen(market)) throw new ApiError(422, "MARKET_NOT_OPEN", "This market is not open for trading.");
    if (input.marketVersion !== undefined && market.version !== input.marketVersion) {
      throw new ApiError(409, "STALE_MARKET", "Market prices changed. Refresh and request a new quote.", {
        currentVersion: market.version,
      });
    }
    if (input.action === "SELL") {
      const position = await tx.position.findUnique({
        where: { userId_marketId: { userId: input.userId, marketId: input.marketId } },
      });
      if (availableUnreservedShares(position, input.side) < input.quantity) {
        throw new ApiError(422, "INSUFFICIENT_POSITION", "You do not own enough contracts to sell.");
      }
    }
    const quote = computeQuote(market, input.side, input.action, input.quantity);
    const expiresAt = new Date(Date.now() + 30_000);
    const stored = await tx.tradeQuote.create({
      data: {
        userId: input.userId,
        marketId: input.marketId,
        side: input.side,
        action: input.action,
        quantity: input.quantity,
        amountMilli: quote.grossMilli,
        feeMilli: quote.feeMilli,
        marketVersion: market.version,
        expiresAt,
      },
    });
    return { quoteId: stored.id, marketVersion: market.version, expiresAt, ...quote };
  });
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

async function ensureRevenueAccount(tx: Prisma.TransactionClient) {
  return tx.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: "GOOSEY",
        purpose: "PROTOCOL_REVENUE",
      },
    },
    create: {
      ownerType: "SYSTEM",
      ownerId: "GOOSEY",
      purpose: "PROTOCOL_REVENUE",
      balanceMilli: 0n,
    },
    update: {},
  });
}

function positionMutation(
  position: Position | null,
  quote: ComputedQuote,
): { netCostDelta: bigint; yesCostDelta: bigint; noCostDelta: bigint; realizedDelta: bigint } {
  if (quote.action === "BUY") {
    return {
      netCostDelta: quote.totalDebitMilli!,
      yesCostDelta: quote.side === "YES" ? quote.totalDebitMilli! : 0n,
      noCostDelta: quote.side === "NO" ? quote.totalDebitMilli! : 0n,
      realizedDelta: 0n,
    };
  }
  if (!position) throw new ApiError(422, "INSUFFICIENT_POSITION", "No position exists to sell.");
  const held = quote.side === "YES" ? position.yesShares : position.noShares;
  if (availableUnreservedShares(position, quote.side) < quote.quantity) {
    throw new ApiError(422, "INSUFFICIENT_POSITION", "You do not own enough contracts to sell.");
  }
  const sideBasis = quote.side === "YES" ? position.yesCostBasisMilli : position.noCostBasisMilli;
  const basisRemoved = held > 0 ? (sideBasis * BigInt(quote.quantity)) / BigInt(held) : 0n;
  return {
    netCostDelta: -basisRemoved,
    yesCostDelta: quote.side === "YES" ? -basisRemoved : 0n,
    noCostDelta: quote.side === "NO" ? -basisRemoved : 0n,
    realizedDelta: quote.netCreditMilli! - basisRemoved,
  };
}

export async function executeTrade(input: {
  userId: string;
  authRequest?: NextRequest;
  authorize?: (tx: Prisma.TransactionClient) => Promise<void>;
  marketId: string;
  quoteId: string;
  marketVersion?: number;
  maxDebitMilli?: bigint;
  minCreditMilli?: bigint;
  idempotencyKey: string;
}) {
  await consumeRateLimit(prisma, `trade:${input.userId}`, 20, 60_000);
  const operationAt = new Date();
  const idempotencyExpiresAt = new Date(operationAt.getTime() + 24 * 60 * 60 * 1_000);
  const route = `/api/markets/${input.marketId}/trades`;
  const journalScope = principalScopedIdempotencyScope(route, input.userId);
  const requestHash = createHash("sha256")
    .update(
      jsonStringify({
        quoteId: input.quoteId,
        marketVersion: input.marketVersion,
        maxDebitMilli: input.maxDebitMilli,
        minCreditMilli: input.minCreditMilli,
      }),
    )
    .digest("hex");

  return runSerializableTransaction(
    prisma,
    async (tx) => {
      if (input.authRequest) await assertMutationSession(tx, input.authRequest, input.userId);
      if (input.authorize) await input.authorize(tx);
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
        throw new ApiError(409, "REQUEST_IN_PROGRESS", "This request is already being processed.");
      }
      const reusedTradeKey = await tx.trade.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });
      if (reusedTradeKey) {
        throw new ApiError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This idempotency key was already used for another trade.",
        );
      }
      await tx.idempotencyRequest.create({
        data: {
          userId: input.userId,
          route,
          key: input.idempotencyKey,
          requestHash,
          expiresAt: idempotencyExpiresAt,
        },
      });

      const [user, market, storedQuote, position] = await Promise.all([
        tx.user.findUnique({ where: { id: input.userId } }),
        tx.market.findUnique({
          where: { id: input.marketId },
          include: { collateralAccount: true },
        }),
        tx.tradeQuote.findUnique({ where: { id: input.quoteId } }),
        tx.position.findUnique({
          where: { userId_marketId: { userId: input.userId, marketId: input.marketId } },
        }),
      ]);
      if (!user || user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_INACTIVE", "Account is not active.");
      if (user.role !== "USER") throw new ApiError(403, "PARTICIPANT_REQUIRED", "Privileged accounts cannot trade.");
      if (requiresEmailVerification(user)) throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before trading.");
      if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      if (market.pricingModel !== "LMSR") {
        throw new ApiError(422, "LMSR_UNAVAILABLE", "This market does not use the LMSR trading engine.");
      }
      if (!isLmsrMarketOpen(market, operationAt)) throw new ApiError(422, "MARKET_NOT_OPEN", "This market is not open for trading.");
      if (!storedQuote || storedQuote.userId !== input.userId || storedQuote.marketId !== input.marketId) {
        throw new ApiError(404, "QUOTE_NOT_FOUND", "Quote not found.");
      }
      if (storedQuote.consumedAt || storedQuote.expiresAt <= operationAt) {
        throw new ApiError(409, "QUOTE_EXPIRED", "The quote is expired or already used.");
      }
      const expectedMarketVersion = input.marketVersion ?? storedQuote.marketVersion;
      if (
        storedQuote.marketVersion !== expectedMarketVersion ||
        market.version !== expectedMarketVersion
      ) {
        throw new ApiError(409, "STALE_MARKET", "Market prices changed. Request a new quote.", {
          currentVersion: market.version,
        });
      }

      const side = sideSchema.parse(storedQuote.side);
      const action = actionSchema.parse(storedQuote.action);
      const quote = computeQuote(market, side, action, storedQuote.quantity);
      if (action === "BUY") {
        if (input.maxDebitMilli === undefined || input.minCreditMilli !== undefined) {
          throw new ApiError(400, "INVALID_SLIPPAGE_BOUND", "Buy trades require maxDebitMilli only.");
        }
        if (quote.totalDebitMilli! > input.maxDebitMilli) {
          throw new ApiError(422, "SLIPPAGE_EXCEEDED", "The current cost exceeds your maximum debit.");
        }
      } else {
        if (input.minCreditMilli === undefined || input.maxDebitMilli !== undefined) {
          throw new ApiError(400, "INVALID_SLIPPAGE_BOUND", "Sell trades require minCreditMilli only.");
        }
        if (quote.netCreditMilli! < input.minCreditMilli) {
          throw new ApiError(422, "SLIPPAGE_EXCEEDED", "The current proceeds are below your minimum credit.");
        }
      }

      const consumed = await tx.tradeQuote.updateMany({
        where: { id: storedQuote.id, consumedAt: null, expiresAt: { gt: operationAt } },
        data: { consumedAt: operationAt },
      });
      if (consumed.count !== 1) throw new ApiError(409, "QUOTE_EXPIRED", "The quote is expired or already used.");

      const marketChanged = await tx.market.updateMany({
        where: {
          id: market.id,
          version: expectedMarketVersion,
          status: "OPEN",
          closesAt: { gt: operationAt },
          yesShares: market.yesShares,
          noShares: market.noShares,
        },
        data: {
          yesShares: quote.yesSharesAfter,
          noShares: quote.noSharesAfter,
          version: { increment: 1 },
          volumeMilli: { increment: quote.grossMilli },
          ...(position ? {} : { traderCount: { increment: 1 } }),
        },
      });
      if (marketChanged.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "The market changed while executing this trade.");
      }

      const { netCostDelta, yesCostDelta, noCostDelta, realizedDelta } = positionMutation(position, quote);
      const yesDelta = side === "YES" ? (action === "BUY" ? quote.quantity : -quote.quantity) : 0;
      const noDelta = side === "NO" ? (action === "BUY" ? quote.quantity : -quote.quantity) : 0;
      if (position) {
        const changed = await tx.position.updateMany({
          where: {
            id: position.id,
            yesShares: position.yesShares,
            noShares: position.noShares,
            reservedYesShares: position.reservedYesShares,
            reservedNoShares: position.reservedNoShares,
          },
          data: {
            yesShares: { increment: yesDelta },
            noShares: { increment: noDelta },
            netCostMilli: { increment: netCostDelta },
            yesCostBasisMilli: { increment: yesCostDelta },
            noCostBasisMilli: { increment: noCostDelta },
            realizedPnlMilli: { increment: realizedDelta },
          },
        });
        if (changed.count !== 1) throw new ApiError(409, "RETRYABLE_CONFLICT", "The position changed while trading.");
      } else {
        if (action !== "BUY") throw new ApiError(422, "INSUFFICIENT_POSITION", "No position exists to sell.");
        await tx.position.create({
          data: {
            userId: user.id,
            marketId: market.id,
            yesShares: yesDelta,
            noShares: noDelta,
            netCostMilli: netCostDelta,
            yesCostBasisMilli: yesCostDelta,
            noCostBasisMilli: noCostDelta,
          },
        });
      }

      const userAccount = await ensureUserLedgerAccount(tx, user.id, user.balanceMilli);
      if (userAccount.balanceMilli !== user.balanceMilli) {
        throw new ApiError(
          409,
          "ACCOUNT_RECONCILIATION_REQUIRED",
          "The wallet is temporarily unavailable while its ledger is reconciled.",
        );
      }
      const revenueAccount = quote.feeMilli > 0n ? await ensureRevenueAccount(tx) : null;
      const userDelta = action === "BUY" ? -quote.totalDebitMilli! : quote.netCreditMilli!;
      if (action === "BUY") {
        const [userBalance, ledgerBalance] = await Promise.all([
          tx.user.updateMany({
            where: { id: user.id, status: "ACTIVE", balanceMilli: { gte: quote.totalDebitMilli! } },
            data: { balanceMilli: { decrement: quote.totalDebitMilli! } },
          }),
          tx.ledgerAccount.updateMany({
            where: { id: userAccount.id, status: "ACTIVE", balanceMilli: { gte: quote.totalDebitMilli! } },
            data: { balanceMilli: { decrement: quote.totalDebitMilli! } },
          }),
        ]);
        if (userBalance.count !== 1 || ledgerBalance.count !== 1) {
          throw new ApiError(422, "INSUFFICIENT_BALANCE", "You do not have enough feathers.");
        }
      } else {
        await Promise.all([
          tx.user.update({
            where: { id: user.id },
            data: {
              balanceMilli: { increment: quote.netCreditMilli! },
              realizedPnlMilli: { increment: realizedDelta },
            },
          }),
          tx.ledgerAccount.update({
            where: { id: userAccount.id },
            data: { balanceMilli: { increment: quote.netCreditMilli! } },
          }),
        ]);
      }

      const collateralDelta = action === "BUY" ? quote.grossMilli : -quote.grossMilli;
      const collateralAfter = market.collateralAccount.balanceMilli + collateralDelta;
      const requiredCollateral = requiredCollateralMilli({
        yesQuantity: quote.yesSharesAfter,
        noQuantity: quote.noSharesAfter,
        liquidity: market.liquidityParameter,
        payoutMilli: market.payoutMilli,
      });
      if (collateralAfter < requiredCollateral) {
        throw new ApiError(409, "MARKET_UNDERCOLLATERALIZED", "The market lacks sufficient collateral for this trade.");
      }
      const collateralChanged = await tx.ledgerAccount.updateMany({
        where: {
          id: market.collateralAccount.id,
          status: "ACTIVE",
          balanceMilli: market.collateralAccount.balanceMilli,
        },
        data: {
          balanceMilli:
            action === "BUY"
              ? { increment: quote.grossMilli }
              : { decrement: quote.grossMilli },
        },
      });
      if (collateralChanged.count !== 1) {
        throw new ApiError(409, "RETRYABLE_CONFLICT", "Market collateral changed while trading.");
      }
      if (revenueAccount && quote.feeMilli > 0n) {
        await tx.ledgerAccount.update({
          where: { id: revenueAccount.id },
          data: { balanceMilli: { increment: quote.feeMilli } },
        });
      }

      const trade = await tx.trade.create({
        data: {
          userId: user.id,
          marketId: market.id,
          side,
          action,
          quantity: quote.quantity,
          amountMilli: quote.grossMilli,
          feeMilli: quote.feeMilli,
          priceBeforeBps: quote.probabilityYesBeforeBps,
          priceAfterBps: quote.probabilityYesAfterBps,
          idempotencyKey: input.idempotencyKey,
          createdAt: operationAt,
        },
      });
      const postings = [
        { ledgerAccountId: userAccount.id, amountMilli: userDelta },
        { ledgerAccountId: market.collateralAccount.id, amountMilli: action === "BUY" ? quote.grossMilli : -quote.grossMilli },
        ...(revenueAccount && quote.feeMilli > 0n
          ? [{ ledgerAccountId: revenueAccount.id, amountMilli: quote.feeMilli }]
          : []),
      ];
      const postingSum = postings.reduce((sum, posting) => sum + posting.amountMilli, 0n);
      if (postingSum !== 0n) throw new Error("Unbalanced journal entry");
      const journal = await tx.journalEntry.create({
        data: {
          type: action,
          referenceType: "TRADE",
          referenceId: trade.id,
          idempotencyScope: journalScope,
          idempotencyKey: input.idempotencyKey,
          actorUserId: user.id,
          metadata: jsonStringify({
            marketId: market.id,
            side,
            action,
            quantity: quote.quantity,
            marketVersion: expectedMarketVersion,
          }),
          postings: { create: postings },
        },
      });
      await tx.marketPriceSnapshot.create({
        data: { marketId: market.id, yesProbabilityBps: quote.probabilityYesAfterBps, createdAt: operationAt },
      });
      await tx.notification.create({
        data: {
          userId: user.id,
          type: "TRADE_CONFIRMED",
          title: `${action === "BUY" ? "Bought" : "Sold"} ${quote.quantity} ${side}`,
          body: `Your ${market.shortTitle} trade was confirmed at an average of ${notificationFeathers(quote.averagePriceMilli)} feathers per contract.`,
          href: `/markets/${market.slug}`,
        },
      });

      const result = {
        trade: { ...trade, journalEntryId: journal.id },
        market: {
          id: market.id,
          version: market.version + 1,
          yesShares: quote.yesSharesAfter,
          noShares: quote.noSharesAfter,
          probabilityYesBps: quote.probabilityYesAfterBps,
        },
        balanceMilli: user.balanceMilli + userDelta,
      };
      const responseBody = jsonStringify(result);
      await tx.idempotencyRequest.update({
        where: { userId_route_key: { userId: user.id, route, key: input.idempotencyKey } },
        data: { status: "COMPLETED", responseCode: 201, responseBody },
      });
      return JSON.parse(responseBody) as unknown;
    },
    { timeoutMs: 10_000 },
  );
}

export function executablePositionValue(
  market: Pick<Market, "yesShares" | "noShares" | "liquidityParameter" | "payoutMilli" | "feeBps" | "status" | "resolution"> & Partial<Pick<Market, "pricingModel">>,
  position: Pick<Position, "yesShares" | "noShares">,
): bigint {
  if (market.pricingModel === "ORDER_BOOK") throw new Error("Order-book holdings require a live-book valuation snapshot.");
  const pairs = Math.min(position.yesShares, position.noShares);
  let value = BigInt(pairs) * market.payoutMilli;
  const remainingYes = position.yesShares - pairs;
  const remainingNo = position.noShares - pairs;
  if (market.status === "RESOLVED") {
    if (market.resolution === "YES") value += BigInt(remainingYes) * market.payoutMilli;
    if (market.resolution === "NO") value += BigInt(remainingNo) * market.payoutMilli;
    return value;
  }
  if (market.status === "VOID") {
    return value + (BigInt(remainingYes + remainingNo) * market.payoutMilli) / 2n;
  }
  if (remainingYes > 0) value += positionSideLiquidationValueMilli(market, "YES", remainingYes);
  if (remainingNo > 0) value += positionSideLiquidationValueMilli(market, "NO", remainingNo);
  return value;
}

export function positionSideLiquidationValueMilli(
  market: Pick<Market, "yesShares" | "noShares" | "liquidityParameter" | "payoutMilli" | "feeBps">,
  side: Side,
  quantity: number,
): bigint {
  return sellLiquidationValueMilli({
    yesQuantity: market.yesShares,
    noQuantity: market.noShares,
    liquidity: market.liquidityParameter,
    payoutMilli: market.payoutMilli,
  }, side, quantity, market.feeBps);
}
