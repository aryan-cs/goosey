import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

import { htnMarkets as markets, htnEvents as events } from "./htn-2026-markets";
import { lmsrCostMilli, probabilityYesBps } from "../src/lib/market-maker";

const prisma = new PrismaClient();
const PAYOUT_MILLI = 100_000n;
const SEED_IDEMPOTENCY_KEYS: Record<string, string> = {
  "htn-2026-goose-incidents-1": "htn-2026-goose-incidents-1:reported-v2",
};

async function main() {
  const systemPassword = await hash(randomBytes(48).toString("base64url"), 12);
  const system = await prisma.user.upsert({
    where: { email: "system@goosey.local" },
    update: { emailVerifiedAt: new Date() },
    create: {
      email: "system@goosey.local",
      username: "goosey-desk",
      displayName: "Goosey Desk",
      passwordHash: systemPassword,
      emailVerifiedAt: new Date(),
      role: "SYSTEM",
      status: "ACTIVE",
      balanceMilli: 0n,
      bio: "Automated market operations account.",
    },
  });

  const treasury = await prisma.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: "treasury",
        purpose: "TREASURY",
      },
    },
    update: {},
    create: {
      ownerType: "SYSTEM",
      ownerId: "treasury",
      purpose: "TREASURY",
      allowsNegative: true,
      balanceMilli: 0n,
    },
  });

  await prisma.ledgerAccount.upsert({
    where: {
      ownerType_ownerId_purpose: {
        ownerType: "SYSTEM",
        ownerId: "issuance",
        purpose: "ISSUANCE",
      },
    },
    update: {},
    create: {
      ownerType: "SYSTEM",
      ownerId: "issuance",
      purpose: "ISSUANCE",
      allowsNegative: true,
      balanceMilli: 0n,
    },
  });

  const eventIds = new Map<string, string>();
  for (const definition of events) {
    const event = await prisma.marketEvent.upsert({
      where: { slug: definition.slug },
      update: {
        title: definition.title,
        shortTitle: definition.shortTitle,
        description: definition.description,
        category: definition.category,
        featured: definition.featured,
        color: definition.color,
        icon: definition.icon,
        createdById: system.id,
      },
      create: {
        slug: definition.slug,
        title: definition.title,
        shortTitle: definition.shortTitle,
        description: definition.description,
        category: definition.category,
        featured: definition.featured,
        color: definition.color,
        icon: definition.icon,
        createdById: system.id,
        startsAt: new Date(definition.startsAt),
        endsAt: new Date(definition.endsAt),
      },
    });
    for (const marketSlug of definition.marketSlugs) eventIds.set(marketSlug, event.id);
  }

  for (const definition of markets) {
    const existing = await prisma.market.findUnique({
      where: { slug: definition.slug },
    });
    if (existing) {
      await prisma.market.update({ where: { id: existing.id }, data: { eventId: eventIds.get(definition.slug) } });
      continue;
    }

    const b = 100;
    // Real, collateralized house inventory establishes the editorial opening price.
    // It is never counted as user activity or fabricated trading volume.
    const logOddsShares = Math.round(b * Math.log(definition.openingProbability / (1 - definition.openingProbability)));
    const qYes = Math.max(0, logOddsShares);
    const qNo = Math.max(0, -logOddsShares);
    const state = { yesQuantity: qYes, noQuantity: qNo, liquidity: b, payoutMilli: PAYOUT_MILLI };
    const pricingModel = "LMSR";
    const subsidy = lmsrCostMilli(state);
    const yesProbabilityBps = probabilityYesBps(state);

    await prisma.$transaction(async (tx) => {
      const market = await tx.market.create({
        data: {
          slug: definition.slug,
          title: definition.title,
          shortTitle: definition.shortTitle,
          description: definition.description,
          rules: definition.rules,
          resolutionSource: definition.resolutionSource,
          category: definition.category,
          status: new Date(definition.closesAt) > new Date() ? "OPEN" : "CLOSED",
          acceptingOrders: new Date(definition.closesAt) > new Date(),
          featured: definition.featured,
          color: definition.color,
          icon: definition.icon,
          closesAt: new Date(definition.closesAt),
          resolvesAt: new Date(definition.resolvesAt),
          yesShares: qYes,
          noShares: qNo,
          liquidityParameter: b,
          payoutMilli: PAYOUT_MILLI,
          pricingModel,
          createdBy: { connect: { id: system.id } },
          event: eventIds.get(definition.slug) ? { connect: { id: eventIds.get(definition.slug)! } } : undefined,
          collateralAccount: {
            create: {
              ownerType: "MARKET",
              purpose: "COLLATERAL",
              balanceMilli: subsidy,
            },
          },
          positions:
            pricingModel === "LMSR" && (qYes || qNo)
              ? {
                  create: {
                    user: { connect: { id: system.id } },
                    yesShares: qYes,
                    noShares: qNo,
                    netCostMilli: 0n,
                  },
                }
              : undefined,
          priceHistory: {
            create: { yesProbabilityBps },
          },
        },
        include: { collateralAccount: true },
      });

      if (pricingModel === "LMSR") {
        await tx.ledgerAccount.update({ where: { id: treasury.id }, data: { balanceMilli: { decrement: subsidy } } });
        await tx.journalEntry.create({
          data: {
            type: "MARKET_SUBSIDY",
            referenceType: "MARKET",
            referenceId: market.id,
            idempotencyScope: "seed-market",
            idempotencyKey: SEED_IDEMPOTENCY_KEYS[market.slug] ?? market.slug,
            actorUserId: system.id,
            metadata: JSON.stringify({ liquidityParameter: b, openingProbability: definition.openingProbability, pricingRationale: definition.pricingRationale, houseInventory: { yes: qYes, no: qNo } }),
            postings: { create: [{ ledgerAccountId: treasury.id, amountMilli: -subsidy }, { ledgerAccountId: market.collateralAccount.id, amountMilli: subsidy }] },
          },
        });
      }

      await tx.ledgerAccount.update({
        where: { id: market.collateralAccount.id },
        data: { ownerId: market.id },
      });
    });
  }

  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    if (adminPassword.length < 12) {
      throw new Error("ADMIN_PASSWORD must be at least 12 characters.");
    }
    const existingAdminEmail = await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } });
    if (existingAdminEmail) throw new Error("ADMIN_EMAIL already exists; refusing to promote an existing account.");
    await prisma.user.create({ data: { email: adminEmail, username: "goosey-admin", displayName: "Goosey Admin", passwordHash: await hash(adminPassword, 12), emailVerifiedAt: new Date(), role: "ADMIN", balanceMilli: 0n } });
  }
}

main()
  .then(() => console.log("Goosey database seeded."))
  .finally(async () => prisma.$disconnect());
