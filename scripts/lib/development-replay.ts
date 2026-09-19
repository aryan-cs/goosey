import { realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { hash } from "bcryptjs";
import { db, databaseRuntime, requireDatabaseStartup } from "../../src/lib/db";
import { grantWelcomeFeathers } from "../../src/lib/auth";
import { createAdminMarket, transitionAdminMarket, createResolutionProposal, approveResolutionProposal } from "../../src/lib/admin-service";
import { createTradeQuote, executeTrade } from "../../src/lib/trading";
import type { DevelopmentScenarioPlan } from "./development-scenarios";
import { processSettlementRun } from "../../src/lib/settlement-service";
import { readSandboxManifest, assertDevelopmentOnly } from "./development-sandbox";

// This module is intentionally a development CLI dependency, never a route dependency.
async function assertSandbox() {
  assertDevelopmentOnly();
  if (process.env.GOOSEY_DEVELOPMENT_SANDBOX !== "1" || databaseRuntime.provider !== "sqlite") throw new Error("Development replay requires an isolated SQLite sandbox.");
  const root = await realpath(path.resolve("output/development-sandbox"));
  const filename = await realpath(databaseRuntime.datasourceUrl.slice(5).split("?")[0]);
  if (path.dirname(path.dirname(filename)) !== root || path.basename(filename) !== "data.sqlite") throw new Error("Replay database must be an owned data.sqlite sandbox under output/development-sandbox.");
  await readSandboxManifest(path.join(path.dirname(filename), "manifest.json"));
  await requireDatabaseStartup();
}

const historicalFields = new Set(["createdAt", "updatedAt", "postedAt", "consumedAt", "decidedAt", "startedAt", "completedAt", "resolvedAt", "terminalAt", "canceledAt", "lastActiveAt"]);
const timestampTables = Prisma.dmmf.datamodel.models.map(model => ({
  table: model.dbName ?? model.name,
  fields: model.fields.filter(field => field.type === "DateTime" && historicalFields.has(field.name)).map(field => field.dbName ?? field.name),
})).filter(model => model.fields.length);

/** Services retain their real production clock. Only this isolated historical replay rewrites dates. */
async function atHistoricalTime<T>(at: Date, action: () => Promise<T>): Promise<T> {
  await db.rateLimitBucket.deleteMany();
  const boundary = new Date();
  const result = await action();
  await db.$transaction(async tx => {
    for (const { table, fields } of timestampTables) {
      const assignments = fields.map(field => `"${field}" = CASE WHEN "${field}" >= ? THEN ? ELSE "${field}" END`).join(", ");
      const where = fields.map(field => `"${field}" >= ?`).join(" OR ");
      const args = [...fields.flatMap(() => [boundary, at]), ...fields.map(() => boundary)];
      // Identifiers originate solely in generated Prisma schema metadata, not CLI input.
      await tx.$executeRawUnsafe(`UPDATE "${table}" SET ${assignments} WHERE ${where}`, ...args);
    }
  }, { timeout: 30_000 });
  return result;
}

async function executeParticipantTrade(input: { marketId: string; userId: string; side: "YES" | "NO"; action: "BUY" | "SELL"; quantity: number; key: string }) {
  const quote = await createTradeQuote(input);
  return executeTrade({ userId: input.userId, marketId: input.marketId, quoteId: quote.quoteId, marketVersion: quote.marketVersion, idempotencyKey: input.key,
    ...(input.action === "BUY" ? { maxDebitMilli: quote.totalDebitMilli! } : { minCreditMilli: quote.netCreditMilli! }),
  });
}

export async function replayDevelopmentData(input: { scenarios: DevelopmentScenarioPlan; password: string; asOf: Date; onProgress?: (message: string) => void }) {
  await assertSandbox();
  if (await db.user.count() || await db.market.count()) throw new Error("Initial replay requires an empty sandbox; use append for existing data.");
  if (input.password.length < 12 || !Number.isFinite(input.asOf.getTime()) || input.asOf > new Date()) throw new Error("Replay requires a 12-character password and a valid asOf no later than now.");
  if (!input.scenarios.markets.length) throw new Error("Replay requires market scenarios.");
  const beginning = new Date(Math.min(...input.scenarios.markets.map(s => s.openedAt.getTime())) - 86_400_000);
  const passwordHash = await hash(input.password, 12);
  const systemHash = await hash(`${randomUUID()}${randomUUID()}`, 12);
  await atHistoricalTime(beginning, () => db.user.create({ data: {
    email: "simulation-system@example.test", username: "simulation-system", displayName: "Simulation Worker",
    passwordHash: systemHash, emailVerifiedAt: beginning, role: "SYSTEM",
    bio: "Non-interactive development settlement worker principal.",
  } }));
  const admins: string[] = [];
  const accounts: { id: string; email: string; username: string; role: string }[] = [];
  for (let index = 0; index < 27; index++) {
    const admin = index < 3;
    const username = admin ? `simulation-admin-${index + 1}` : `simulation-trader-${String(index - 2).padStart(2, "0")}`;
    const user = await atHistoricalTime(beginning, async () => {
      const created = await db.user.create({ data: { email: `${username}@example.test`, username, displayName: admin ? `Simulation Admin ${index + 1}` : `Simulation Trader ${index - 2}`, passwordHash, emailVerifiedAt: beginning, role: admin ? "ADMIN" : "USER", bio: "Synthetic development participant. No real person or trading history.", profilePublic: !admin, leaderboardVisible: !admin } });
      if (!admin) await db.$transaction(tx => grantWelcomeFeathers(tx, created.id));
      return created;
    });
    accounts.push({ id: user.id, email: user.email, username: user.username, role: user.role });
    if (admin) admins.push(user.id);
  }
  const participants = accounts.filter(account => account.role === "USER");
  let tradeCount = 0;
  const marketIds: string[] = [];
  const eventIds = new Map<string, string>();
  for (const event of input.scenarios.events) {
    const earliest = new Date(Math.min(...input.scenarios.markets.filter(m => m.eventSlug === event.slug).map(m => m.openedAt.getTime())));
    const created = await atHistoricalTime(earliest, () => db.marketEvent.create({ data: { ...event, createdById: admins[0] } }));
    eventIds.set(event.slug, created.id);
  }
  for (const [marketIndex, scenario] of input.scenarios.markets.entries()) {
    input.onProgress?.(`Replaying ${scenario.slug} (${marketIndex + 1}/${input.scenarios.markets.length})`);
    if (!(scenario.openedAt < scenario.closesAt && scenario.closesAt <= scenario.resolvesAt)) throw new Error(`Invalid timeline: ${scenario.slug}`);
    const future = new Date(Date.now() + 365 * 86_400_000);
    const created = await atHistoricalTime(scenario.openedAt, () => createAdminMarket({ actorUserId: admins[0], idempotencyKey: `simulation-create-${scenario.slug}`, market: { slug: scenario.slug, title: scenario.title, shortTitle: scenario.shortTitle, description: scenario.description, category: scenario.category, rules: "Synthetic development scenario. Resolve according to the deterministic scenario manifest; no real-world outcome is asserted.", resolutionSource: "Development scenario manifest", eventId: eventIds.get(scenario.eventSlug), status: scenario.finalStatus === "DRAFT" ? "DRAFT" : "OPEN", featured: marketIndex < 4, color: ["gold", "green", "blue", "violet"][marketIndex % 4] as "gold", icon: "sparkles", closesAt: future, resolvesAt: future, pricingModel: "LMSR", liquidityParameter: 80, payoutMilli: 100_000n, feeBps: 50 } }));
    const marketId = created.market.id;
    marketIds.push(marketId);
    let previousAt = scenario.openedAt;
    for (const [tradeIndex, point] of scenario.tradeIntents.entries()) {
      if (point.at < previousAt || point.at < scenario.openedAt || point.at >= scenario.closesAt || point.at > input.asOf) throw new Error(`Invalid trade timestamp in ${scenario.slug}`);
      if (!(point.targetProbability > 0 && point.targetProbability < 1)) throw new Error("Target probability must be strictly between zero and one.");
      previousAt = point.at;
      const market = await db.market.findUniqueOrThrow({ where: { id: marketId } });
      const desiredDifference = Math.round(market.liquidityParameter * Math.log(point.targetProbability / (1 - point.targetProbability)));
      const difference = desiredDifference - (market.yesShares - market.noShares);
      const side = difference >= 0 ? "YES" : "NO";
      const quantity = Math.max(1, Math.min(40, Math.min(point.maxQuantity, Math.abs(difference))));
      const opposite = side === "YES" ? "NO" : "YES";
      const sellPosition = tradeIndex % 4 === 0 ? await db.position.findFirst({ where: { marketId, userId: { in: participants.map(p => p.id) }, ...(opposite === "YES" ? { yesShares: { gte: quantity } } : { noShares: { gte: quantity } }) }, orderBy: { createdAt: "asc" } }) : null;
      const userId = sellPosition?.userId ?? participants[point.participantIndex].id;
      await atHistoricalTime(point.at, () => executeParticipantTrade({ marketId, userId, side: sellPosition ? opposite : side, action: sellPosition ? "SELL" : "BUY", quantity, key: `simulation-trade-${scenario.slug}-${tradeIndex}` }));
      tradeCount++;
      if (tradeIndex % 25 === 0) {
        const position = await db.position.findUniqueOrThrow({ where: { userId_marketId: { userId, marketId } } });
        await db.comment.create({ data: { marketId, userId, body: `[Simulation] After observation ${tradeIndex + 1}, the scenario implies approximately ${Math.round(point.targetProbability * 100)}% YES. This is a development test observation, not real-world evidence.`, positionSideSnapshot: side, positionQtySnapshot: side === "YES" ? position.yesShares : position.noShares, createdAt: point.at, updatedAt: point.at } });
      }
    }
    await db.market.update({ where: { id: marketId }, data: { closesAt: scenario.closesAt, resolvesAt: scenario.resolvesAt, updatedAt: previousAt, commentCount: await db.comment.count({ where: { marketId } }) } });
    for (let watcher = 0; watcher < 5; watcher++) await db.watchlistEntry.create({ data: { marketId, userId: participants[(watcher + marketIndex) % participants.length].id, createdAt: scenario.openedAt } });
    if (scenario.finalStatus !== "OPEN" && scenario.finalStatus !== "DRAFT") {
      const at = scenario.finalStatus === "PAUSED" ? previousAt : scenario.closesAt;
      const market = await db.market.findUniqueOrThrow({ where: { id: marketId } });
      await atHistoricalTime(at, () => transitionAdminMarket({ actorUserId: admins[0], marketId, action: scenario.finalStatus === "PAUSED" ? "PAUSE" : "CLOSE", reason: "Synthetic scenario lifecycle transition", expectedVersion: market.version }));
    }
    if (scenario.finalStatus === "RESOLVED" || scenario.finalStatus === "VOID") {
      if (scenario.resolvesAt > input.asOf) throw new Error("Cannot settle a future scenario.");
      await atHistoricalTime(scenario.resolvedAt ?? scenario.resolvesAt, async () => {
        const proposal = await createResolutionProposal({ actorUserId: admins[1], marketId, idempotencyKey: `simulation-propose-${scenario.slug}`, resolution: { outcome: scenario.finalStatus === "VOID" ? "VOID" : scenario.resolution ?? "YES", reason: "Deterministic synthetic development scenario completed.", evidence: "Development manifest; this does not assert any real-world result." } });
        const approval = await approveResolutionProposal({ actorUserId: admins[2], proposalId: proposal.proposal.id, idempotencyKey: `simulation-approve-${scenario.slug}` });
        for (let batch = 0; batch < 100; batch++) {
          await processSettlementRun({ actorUserId: admins[2], runId: approval.run.id, batchSize: 100 });
          const run = await db.marketSettlementRun.findUniqueOrThrow({ where: { id: approval.run.id } });
          if (run.status === "COMPLETED") return;
        }
        throw new Error("Synthetic settlement did not complete in 100 batches.");
      });
    }
  }
  await db.rateLimitBucket.deleteMany();
  return { accounts, marketIds, tradeCount, asOf: input.asOf.toISOString() };
}

export async function appendDevelopmentTrades(input: { count: number; onProgress?: (message: string) => void }) {
  await assertSandbox();
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 1000) throw new Error("Append count must be between 1 and 1000.");
  const users = await db.user.findMany({ where: { role: "USER", username: { startsWith: "simulation-trader-" } }, orderBy: { username: "asc" } });
  const markets = await db.market.findMany({ where: { status: "OPEN", acceptingOrders: true, closesAt: { gt: new Date() }, slug: { startsWith: "dev-" } }, orderBy: { slug: "asc" } });
  if (!users.length || !markets.length) throw new Error("No active synthetic participants or open simulation markets; regenerate the sandbox with a current asOf.");
  const run = randomUUID();
  for (let index = 0; index < input.count; index++) {
    await db.rateLimitBucket.deleteMany();
    await executeParticipantTrade({ marketId: markets[index % markets.length].id, userId: users[index % users.length].id, side: index % 2 ? "NO" : "YES", action: "BUY", quantity: 1 + index % 4, key: `simulation-agent-${run}-${index}` });
  }
  input.onProgress?.(`Appended ${input.count} actual development trades.`);
  return { appendedTrades: input.count, run };
}

export async function disconnectDevelopmentDatabase() { await db.$disconnect(); }
