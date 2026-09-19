import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PAYOUT_MILLI = 100_000n;

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 60 * 60 * 1_000);

const probabilityBps = (yesShares: number, noShares: number, b: number) => {
  const diff = Math.max(-60, Math.min(60, (noShares - yesShares) / b));
  return Math.round(10_000 / (1 + Math.exp(diff)));
};

const subsidyMilli = (b: number) =>
  BigInt(Math.ceil(b * Number(PAYOUT_MILLI) * Math.LN2));

const markets = [
  {
    slug: "closing-ceremony-on-time",
    title: "Will the closing ceremony begin within 10 minutes of schedule?",
    shortTitle: "Closing ceremony on time?",
    description:
      "A classic hackathon forecast: will the final ceremony keep to the published schedule?",
    rules:
      "Resolves YES if the first official closing-ceremony remarks begin no later than 10 minutes after the published start time. Organizer-requested audience seating or a countdown does not count as opening remarks.",
    resolutionSource: "Official event schedule and the organizer stage timestamp",
    category: "Hack the North",
    icon: "clock",
    color: "gold",
    featured: true,
    hours: 36,
    qYes: 12,
    qNo: 0,
  },
  {
    slug: "hardware-top-prize",
    title: "Will a hardware-first project win a top overall prize?",
    shortTitle: "Hardware project wins?",
    description:
      "Forecast whether a project whose core demo depends on custom physical hardware reaches the overall podium.",
    rules:
      "Resolves YES if at least one project receiving an overall first, second, or third-place prize requires custom physical hardware for its core demonstrated function. Ordinary laptops and phones do not qualify.",
    resolutionSource: "Official Hack the North winner announcement and public project demo",
    category: "Demos",
    icon: "cpu",
    color: "blue",
    featured: true,
    hours: 34,
    qYes: 5,
    qNo: 0,
  },
  {
    slug: "gallery-150-projects",
    title: "Will at least 150 projects appear in the public showcase gallery?",
    shortTitle: "150+ submitted projects?",
    description:
      "A volume forecast for the public project gallery after submissions close.",
    rules:
      "Resolves YES if the official public gallery lists 150 or more distinct eligible projects at the judging deadline. Withdrawn, duplicate, or private entries are excluded.",
    resolutionSource: "Official Hack the North public project gallery",
    category: "Demos",
    icon: "grid",
    color: "green",
    featured: true,
    hours: 27,
    qYes: 18,
    qNo: 0,
  },
  {
    slug: "midnight-snack-before-1215",
    title: "Will the midnight snack open before 12:15 a.m.?",
    shortTitle: "Midnight snack before 12:15?",
    description:
      "Predict whether hungry hackers can begin receiving the scheduled midnight snack before 12:15 a.m.",
    rules:
      "Resolves YES when the first attendee can receive the scheduled midnight snack before 12:15 a.m. local time. Staff setup alone does not count.",
    resolutionSource: "Organizer food-service log or timestamped organizer announcement",
    category: "Food",
    icon: "utensils",
    color: "orange",
    featured: false,
    hours: 8,
    qYes: 0,
    qNo: 7,
  },
  {
    slug: "goose-in-demo",
    title: "Will a goose appear in a finalist demo?",
    shortTitle: "Goose in a finalist demo?",
    description:
      "Real goose, generated goose, plush goose, or goose footage: will one make the finalist stage?",
    rules:
      "Resolves YES if a clearly recognizable goose appears visually or audibly as part of any finalist's judged stage demo. Audience clothing and unrelated venue signage do not count.",
    resolutionSource: "Official finalist livestream or organizer recording",
    category: "Community",
    icon: "bird",
    color: "sky",
    featured: false,
    hours: 33,
    qYes: 0,
    qNo: 16,
  },
  {
    slug: "ai-majority-finalists",
    title: "Will a majority of finalists prominently use AI?",
    shortTitle: "AI in most finalist projects?",
    description:
      "Forecast whether AI is a core demonstrated capability in more than half of finalist projects.",
    rules:
      "Resolves YES if more than 50% of finalist projects describe a machine-learning model or generative AI system as necessary to their core demonstrated feature. Incidental API autocomplete does not qualify.",
    resolutionSource: "Finalist demos and official public project descriptions",
    category: "Tech",
    icon: "sparkles",
    color: "violet",
    featured: false,
    hours: 32,
    qYes: 20,
    qNo: 0,
  },
  {
    slug: "waterloo-team-podium",
    title: "Will a team with a Waterloo student place in the overall top three?",
    shortTitle: "Waterloo team on podium?",
    description:
      "A hometown forecast for the overall hackathon podium.",
    rules:
      "Resolves YES if at least one officially listed member of an overall first, second, or third-place team is enrolled at the University of Waterloo at the submission deadline.",
    resolutionSource: "Official winner announcement and team-member project profiles",
    category: "Waterloo",
    icon: "trophy",
    color: "gold",
    featured: false,
    hours: 35,
    qYes: 15,
    qNo: 0,
  },
  {
    slug: "outdoor-temperature-20",
    title: "Will Waterloo reach 20°C during demo day?",
    shortTitle: "20°C on demo day?",
    description:
      "A weather market settled from the official hourly observation closest to campus.",
    rules:
      "Resolves YES if Environment and Climate Change Canada reports a temperature of at least 20.0°C at the Waterloo-Wellington station at any point from 8:00 a.m. through 8:00 p.m. local time on demo day.",
    resolutionSource: "Environment and Climate Change Canada hourly observations",
    category: "Campus",
    icon: "cloud-sun",
    color: "sky",
    featured: false,
    hours: 30,
    qYes: 0,
    qNo: 9,
  },
  {
    slug: "workshop-capacity",
    title: "Will at least one workshop hit posted capacity?",
    shortTitle: "Workshop reaches capacity?",
    description:
      "Forecast whether demand causes an organizer to mark any workshop full.",
    rules:
      "Resolves YES if event staff publicly marks a scheduled workshop at capacity or turns away attendees because all available seats are occupied.",
    resolutionSource: "Official event app notices or organizer room-capacity log",
    category: "Workshops",
    icon: "users",
    color: "green",
    featured: false,
    hours: 22,
    qYes: 8,
    qNo: 0,
  },
  {
    slug: "finalist-live-demo-success",
    title: "Will every finalist complete a working live demo?",
    shortTitle: "Every finalist demo works?",
    description:
      "Predict the clean sweep: every finalist shows its core feature running live on stage.",
    rules:
      "Resolves YES only if every finalist visibly demonstrates its stated core feature functioning during the judged presentation. A prerecorded video alone does not qualify, but a live demo with minor unrelated glitches does.",
    resolutionSource: "Official finalist presentations and judges' stage record",
    category: "Demos",
    icon: "presentation",
    color: "red",
    featured: false,
    hours: 33,
    qYes: 0,
    qNo: 12,
  },
  {
    slug: "venue-wifi-through-demos",
    title: "Will the main Hack the North venue Wi-Fi stay available through demos?",
    shortTitle: "Venue Wi-Fi stays up?",
    description: "A participant-powered order book for whether the main venue network remains available throughout the demo period.",
    rules: "Resolves YES if the official participant Wi-Fi in the main venue remains usable for ordinary web access throughout the published demo period, with no organizer-confirmed outage lasting 15 consecutive minutes or longer.",
    resolutionSource: "Organizer network incident log and official participant announcements",
    category: "Hack the North",
    icon: "wifi",
    color: "blue",
    featured: false,
    hours: 31,
    qYes: 0,
    qNo: 0,
    pricingModel: "ORDER_BOOK",
  },
] as const;

const events = [
  {
    slug: "hack-the-north-finals",
    title: "Hack the North finals and closing ceremony",
    shortTitle: "Finals weekend",
    description: "A collection of objectively resolved forecasts about finalist demos, awards, and the closing ceremony.",
    category: "Hack the North",
    featured: true,
    color: "gold",
    icon: "trophy",
    startsInHours: 24,
    endsInHours: 44,
    marketSlugs: ["closing-ceremony-on-time", "hardware-top-prize", "gallery-150-projects", "goose-in-demo", "ai-majority-finalists", "waterloo-team-podium", "finalist-live-demo-success", "venue-wifi-through-demos"],
  },
  {
    slug: "campus-hackathon-life",
    title: "Campus and hacker life",
    shortTitle: "Around campus",
    description: "Food, workshops, and Waterloo conditions surrounding the hackathon weekend.",
    category: "Campus",
    featured: false,
    color: "green",
    icon: "map",
    startsInHours: 1,
    endsInHours: 38,
    marketSlugs: ["midnight-snack-before-1215", "outdoor-temperature-20", "workshop-capacity"],
  },
] as const;

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
        startsAt: hoursFromNow(definition.startsInHours),
        endsAt: hoursFromNow(definition.endsInHours),
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

    const b = 40;
    const pricingModel = "pricingModel" in definition ? definition.pricingModel : "LMSR";
    const subsidy = pricingModel === "LMSR" ? subsidyMilli(b) : 0n;
    const yesProbabilityBps = probabilityBps(
      definition.qYes,
      definition.qNo,
      b,
    );

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
          status: "OPEN",
          featured: definition.featured,
          color: definition.color,
          icon: definition.icon,
          closesAt: hoursFromNow(definition.hours),
          resolvesAt: hoursFromNow(definition.hours + 8),
          yesShares: definition.qYes,
          noShares: definition.qNo,
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
            pricingModel === "LMSR" && (definition.qYes || definition.qNo)
              ? {
                  create: {
                    user: { connect: { id: system.id } },
                    yesShares: definition.qYes,
                    noShares: definition.qNo,
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
            idempotencyKey: market.slug,
            actorUserId: system.id,
            metadata: JSON.stringify({ liquidityParameter: b }),
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
