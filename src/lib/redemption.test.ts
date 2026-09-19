import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { principalScopedIdempotencyScope, prisma } from "./market-service";
import {
  availableCompleteSets,
  computeRedemptionAccounting,
  redeemCompleteSet,
  redemptionRequestHash,
  redemptionRequestSchema,
} from "./redemption";

describe("complete-set redemption availability", () => {
  it("counts only YES and NO shares that are not reserved", () => {
    expect(
      availableCompleteSets({
        yesShares: 9,
        noShares: 7,
        reservedYesShares: 4,
        reservedNoShares: 1,
      }),
    ).toBe(5);
  });

  it("uses the scarcer unreserved side", () => {
    expect(
      availableCompleteSets({
        yesShares: 10,
        noShares: 10,
        reservedYesShares: 8,
        reservedNoShares: 3,
      }),
    ).toBe(2);
  });

  it("rejects reservations that exceed the position", () => {
    expect(() =>
      availableCompleteSets({
        yesShares: 2,
        noShares: 2,
        reservedYesShares: 3,
        reservedNoShares: 0,
      }),
    ).toThrow(/reconciliation/i);
  });
});

describe("complete-set redemption accounting", () => {
  it("pays one exact market payout per matching pair and realizes removed basis", () => {
    const result = computeRedemptionAccounting(
      {
        yesShares: 4,
        noShares: 4,
        yesCostBasisMilli: 210_003n,
        noCostBasisMilli: 189_997n,
        netCostMilli: 400_000n,
      },
      100_000n,
      4,
    );

    expect(result).toEqual({
      payoutMilli: 400_000n,
      yesBasisRemovedMilli: 210_003n,
      noBasisRemovedMilli: 189_997n,
      totalBasisRemovedMilli: 400_000n,
      realizedPnlDeltaMilli: 0n,
      yesSharesAfter: 0,
      noSharesAfter: 0,
      yesCostBasisAfterMilli: 0n,
      noCostBasisAfterMilli: 0n,
      netCostAfterMilli: 0n,
    });
  });

  it("removes each side's basis proportionally with deterministic integer rounding", () => {
    const result = computeRedemptionAccounting(
      {
        yesShares: 7,
        noShares: 5,
        yesCostBasisMilli: 350_003n,
        noCostBasisMilli: 225_004n,
        netCostMilli: 575_007n,
      },
      100_000n,
      3,
    );

    expect(result.yesBasisRemovedMilli).toBe(150_001n);
    expect(result.noBasisRemovedMilli).toBe(135_002n);
    expect(result.payoutMilli).toBe(300_000n);
    expect(result.realizedPnlDeltaMilli).toBe(14_997n);
    expect(result.yesSharesAfter).toBe(4);
    expect(result.noSharesAfter).toBe(2);
    expect(result.netCostAfterMilli).toBe(
      result.yesCostBasisAfterMilli + result.noCostBasisAfterMilli,
    );
  });

  it("preserves all basis on a side when only unmatched contracts remain", () => {
    const result = computeRedemptionAccounting(
      {
        yesShares: 2,
        noShares: 6,
        yesCostBasisMilli: 120_000n,
        noCostBasisMilli: 270_000n,
        netCostMilli: 390_000n,
      },
      100_000n,
      2,
    );

    expect(result.yesCostBasisAfterMilli).toBe(0n);
    expect(result.noCostBasisAfterMilli).toBe(180_000n);
    expect(result.netCostAfterMilli).toBe(180_000n);
    expect(result.realizedPnlDeltaMilli).toBe(-10_000n);
  });

  it("rejects impossible pairs and unreconciled basis", () => {
    expect(() =>
      computeRedemptionAccounting(
        { yesShares: 1, noShares: 0, yesCostBasisMilli: 10n, noCostBasisMilli: 0n, netCostMilli: 10n },
        100_000n,
        1,
      ),
    ).toThrow(/complete set/i);
    expect(() =>
      computeRedemptionAccounting(
        { yesShares: 1, noShares: 1, yesCostBasisMilli: 10n, noCostBasisMilli: 20n, netCostMilli: 31n },
        100_000n,
        1,
      ),
    ).toThrow(/reconciliation/i);
  });
});

describe.runIf(process.env.RUN_REDEMPTION_INTEGRATION === "1")(
  "complete-set redemption transaction",
  () => {
    const fixtureSuffixes: string[] = [];

    afterEach(async () => {
      for (const suffix of fixtureSuffixes.splice(0)) {
        const users = await prisma.user.findMany({
          where: { email: { in: [`redeem-admin-${suffix}@goosey.test`, `redeem-user-${suffix}@goosey.test`] } },
          select: { id: true },
        });
        const userIds = users.map((user) => user.id);
        const journals = await prisma.journalEntry.findMany({
          where: { actorUserId: { in: userIds } },
          select: { id: true },
        });
        const journalIds = journals.map((journal) => journal.id);
        await prisma.$transaction([
          prisma.notification.deleteMany({ where: { userId: { in: userIds } } }),
          prisma.ledgerPosting.deleteMany({ where: { journalEntryId: { in: journalIds } } }),
          prisma.journalEntry.deleteMany({ where: { id: { in: journalIds } } }),
          prisma.idempotencyRequest.deleteMany({ where: { userId: { in: userIds } } }),
          prisma.position.deleteMany({ where: { userId: { in: userIds } } }),
          prisma.market.deleteMany({ where: { slug: `redeem-market-${suffix}` } }),
          prisma.ledgerAccount.deleteMany({
            where: { OR: [{ ownerId: { in: userIds } }, { ownerId: `redeem-market-${suffix}` }] },
          }),
          prisma.user.deleteMany({ where: { id: { in: userIds } } }),
        ]);
      }
    });

    it("atomically updates contracts, balances, basis, P/L, journal, and idempotency", async () => {
      const suffix = randomUUID().slice(0, 8);
      fixtureSuffixes.push(suffix);
      const creator = await prisma.user.create({
        data: {
          email: `redeem-admin-${suffix}@goosey.test`,
          username: `redeem_admin_${suffix}`,
          displayName: "Redemption test administrator",
          passwordHash: "not-used-by-this-service-test",
          role: "ADMIN",
        },
      });
      const user = await prisma.user.create({
        data: {
          email: `redeem-user-${suffix}@goosey.test`,
          username: `redeem_user_${suffix}`,
          displayName: "Redemption test participant",
          passwordHash: "not-used-by-this-service-test",
          balanceMilli: 1_000_000n,
        },
      });
      const [userAccount, collateralAccount] = await Promise.all([
        prisma.ledgerAccount.create({
          data: {
            ownerType: "USER",
            ownerId: user.id,
            purpose: "USER_FEATHERS",
            balanceMilli: 1_000_000n,
          },
        }),
        prisma.ledgerAccount.create({
          data: {
            ownerType: "MARKET",
            ownerId: `redeem-market-${suffix}`,
            purpose: "MARKET_COLLATERAL",
            balanceMilli: 800_000n,
          },
        }),
      ]);
      const market = await prisma.market.create({
        data: {
          slug: `redeem-market-${suffix}`,
          title: "Will this isolated redemption transaction remain balanced?",
          shortTitle: "Redemption transaction test",
          description: "An isolated database-backed redemption transaction test.",
          rules: "This test market remains unresolved while its complete sets are redeemed.",
          resolutionSource: "Goosey integration test",
          category: "Testing",
          status: "OPEN",
          closesAt: new Date(Date.now() + 60_000),
          resolvesAt: new Date(Date.now() + 120_000),
          yesShares: 8,
          noShares: 6,
          liquidityParameter: 40,
          payoutMilli: 100_000n,
          version: 4,
          createdById: creator.id,
          collateralAccountId: collateralAccount.id,
        },
      });
      await prisma.position.create({
        data: {
          userId: user.id,
          marketId: market.id,
          yesShares: 8,
          noShares: 6,
          yesCostBasisMilli: 400_003n,
          noCostBasisMilli: 270_004n,
          netCostMilli: 670_007n,
          reservedYesShares: 5,
          reservedNoShares: 3,
        },
      });

      const idempotencyKey = `redeem-${suffix}-request`;
      await expect(
        redeemCompleteSet({
          userId: user.id,
          marketId: market.id,
          quantity: 4,
          marketVersion: 4,
          idempotencyKey: `redeem-${suffix}-reserved`,
        }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_COMPLETE_SETS",
        details: { availableQuantity: 3 },
      });

      const first = (await redeemCompleteSet({
        userId: user.id,
        marketId: market.id,
        quantity: 3,
        marketVersion: 4,
        idempotencyKey,
      })) as { redemptionId: string; payoutMilli: string; balanceMilli: string };
      const replay = (await redeemCompleteSet({
        userId: user.id,
        marketId: market.id,
        quantity: 3,
        marketVersion: 4,
        idempotencyKey,
      })) as typeof first;

      expect(replay).toEqual(first);
      expect(first.payoutMilli).toBe("300000");
      expect(first.balanceMilli).toBe("1300000");

      const [storedMarket, storedPosition, storedUser, storedUserAccount, journal, request] =
        await Promise.all([
          prisma.market.findUniqueOrThrow({ where: { id: market.id } }),
          prisma.position.findUniqueOrThrow({
            where: { userId_marketId: { userId: user.id, marketId: market.id } },
          }),
          prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
          prisma.ledgerAccount.findUniqueOrThrow({ where: { id: userAccount.id } }),
          prisma.journalEntry.findUniqueOrThrow({
            where: { id: first.redemptionId },
            include: { postings: true },
          }),
          prisma.idempotencyRequest.findUniqueOrThrow({
            where: {
              userId_route_key: {
                userId: user.id,
                route: `/api/markets/${market.id}/redeem`,
                key: idempotencyKey,
              },
            },
          }),
        ]);
      const storedCollateral = await prisma.ledgerAccount.findUniqueOrThrow({
        where: { id: collateralAccount.id },
      });

      expect(storedMarket).toMatchObject({ yesShares: 5, noShares: 3, version: 5 });
      expect(storedPosition).toMatchObject({
        yesShares: 5,
        noShares: 3,
        reservedYesShares: 5,
        reservedNoShares: 3,
      });
      expect(storedPosition.yesCostBasisMilli).toBe(250_002n);
      expect(storedPosition.noCostBasisMilli).toBe(135_002n);
      expect(storedPosition.netCostMilli).toBe(385_004n);
      expect(storedPosition.realizedPnlMilli).toBe(14_997n);
      expect(storedUser.balanceMilli).toBe(1_300_000n);
      expect(storedUser.realizedPnlMilli).toBe(14_997n);
      expect(storedUserAccount.balanceMilli).toBe(1_300_000n);
      expect(storedCollateral.balanceMilli).toBe(500_000n);
      expect(journal.postings).toHaveLength(2);
      expect(journal.postings.every((posting) => posting.amountMilli !== 0n)).toBe(true);
      expect(journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n)).toBe(0n);
      expect(request.status).toBe("COMPLETED");
      expect(
        await prisma.journalEntry.count({
          where: {
            idempotencyScope: principalScopedIdempotencyScope(
              `/api/markets/${market.id}/redeem`,
              user.id,
            ),
            idempotencyKey,
          },
        }),
      ).toBe(1);

      await expect(
        redeemCompleteSet({
          userId: user.id,
          marketId: market.id,
          quantity: 2,
          marketVersion: 4,
          idempotencyKey,
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(
        redeemCompleteSet({
          userId: user.id,
          marketId: market.id,
          quantity: 1,
          marketVersion: 4,
          idempotencyKey: `redeem-${suffix}-stale`,
        }),
      ).rejects.toMatchObject({ code: "STALE_MARKET" });
    });
  },
);

describe("complete-set redemption request contract", () => {
  it("requires integer quantity and an explicit nonnegative market version", () => {
    expect(redemptionRequestSchema.parse({ quantity: 2, marketVersion: 7 })).toEqual({
      quantity: 2,
      marketVersion: 7,
    });
    expect(() => redemptionRequestSchema.parse({ quantity: 1.5, marketVersion: 7 })).toThrow();
    expect(() => redemptionRequestSchema.parse({ quantity: 1 })).toThrow();
    expect(() => redemptionRequestSchema.parse({ quantity: 0, marketVersion: 7 })).toThrow();
  });

  it("hashes the full authoritative request deterministically", () => {
    const first = redemptionRequestHash({ quantity: 3, marketVersion: 9 });
    expect(first).toBe(redemptionRequestHash({ quantity: 3, marketVersion: 9 }));
    expect(first).not.toBe(redemptionRequestHash({ quantity: 4, marketVersion: 9 }));
    expect(first).not.toBe(redemptionRequestHash({ quantity: 3, marketVersion: 10 }));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
