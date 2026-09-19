import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ client: undefined as unknown }));
// All actual ORM calls go to a fresh disposable database, never the app DB.
vi.mock("./db", () => ({ db: new Proxy({}, { get(_target, key) {
  const client = state.client as Record<PropertyKey, unknown>;
  const value = client[key];
  return typeof value === "function" ? value.bind(client) : value;
} }) }));
vi.mock("./auth", () => ({ getAuthenticatedUser: async () => null }));
import { GET as listing } from "../app/api/markets/route";
import { GET as detail } from "../app/api/markets/[slug]/route";
import { GET as discovery } from "../app/api/discovery/route";
import { GET as search } from "../app/api/search/route";
import { GET as calendar } from "../app/api/calendar/route";
import { getPublicEvent, listPublicEvents } from "./public-events";
import { loadMarketMarks } from "./market-marks";
import { loadPublicTradeActivity } from "./public-trade-activity";
import { loadTradeHistory } from "./trade-history";
import { loadTradingActivity } from "./trading-activity";
import { getLeaderboardRows } from "./leaderboard";
import { listUserFills, listPublicTrades } from "./fill-service";

const execute = promisify(execFile);
let directory: string, db: PrismaClient;
const closesAt = new Date(Date.now() + 86_400_000);
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-read-boundary-"));
  const file = join(directory, "isolated.sqlite");
  const { stdout } = await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { maxBuffer: 8 * 1024 * 1024 });
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", file, `PRAGMA foreign_keys=ON;\n${stdout}`]);
  db = new PrismaClient({ datasourceUrl: `file:${file}` }); state.client = db;
  await db.user.create({ data: { id: "reader", email: "reader@example.invalid", username: "reader", displayName: "Reader", passwordHash: "isolated-test-only", emailVerifiedAt: new Date() } });
  await db.marketEvent.create({ data: { id: "mixed", slug: "mixed", title: "Mixed", shortTitle: "Mixed", description: "Read isolation test", category: "Campus", startsAt: new Date(0), endsAt: closesAt, createdById: "reader", featured: true } });
  await db.marketEvent.create({ data: { id: "chain-only", slug: "chain-only", title: "Chain only", shortTitle: "Chain", description: "Read isolation test", category: "Campus", startsAt: new Date(0), endsAt: closesAt, createdById: "reader", featured: true } });
  for (const [id, executionBackend, status, eventId] of [
    ["database-a", "DATABASE", "OPEN", "mixed"], ["database-b", "DATABASE", "OPEN", "mixed"],
    ["database-draft", "DATABASE", "DRAFT", "mixed"], ["chain-open", "SOLANA", "OPEN", "mixed"],
    ["chain-draft", "SOLANA", "DRAFT", "mixed"], ["chain-only-market", "SOLANA", "OPEN", "chain-only"],
  ]) {
    await db.market.create({ data: { id, slug: id, executionBackend, status, event: { connect: { id: eventId } },
      title: `Forecast ${id}`, shortTitle: id, description: "Read isolation fixture", rules: "Test only", resolutionSource: "Test only", category: "Campus",
      pricingModel: "ORDER_BOOK", closesAt, resolvesAt: closesAt, createdBy: { connect: { id: "reader" } },
      ...(executionBackend === "DATABASE" ? { collateralAccount: { create: { ownerType: "MARKET", ownerId: id, purpose: "COLLATERAL" } } } : {}),
    } });
  }
  // Intentionally contaminated isolated SQL history verifies defensive filters.
  // These are test fixtures, not representations of real chain transactions.
  for (const marketId of ["database-a", "chain-open"]) {
    await db.trade.create({ data: { userId: "reader", marketId, side: "YES", action: "BUY", quantity: 1, amountMilli: 40000n, priceBeforeBps: 4000, priceAfterBps: 4000, idempotencyKey: marketId } });
  }
  await db.position.create({ data: { userId: "reader", marketId: "chain-open", yesShares: 99 } });
  await db.watchlistEntry.create({ data: { userId: "reader", marketId: "chain-open" } });
  await db.comment.create({ data: { userId: "reader", marketId: "chain-open", body: "Shared metadata stays intact" } });
}, 30000);
afterAll(async () => { await db?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });
const request = (path: string) => new NextRequest(`http://localhost${path}`);

describe("legacy read isolation — real disposable SQLite", () => {
  it("paginates only public database markets without chain/default rows", async () => {
    const first = await listing(request("/api/markets?limit=1&sort=newest"));
    expect(first.status).toBe(200);
    const page = await first.json();
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTruthy();
    const second = await (await listing(request(`/api/markets?limit=1&sort=newest&cursor=${encodeURIComponent(page.nextCursor)}`))).json();
    expect(new Set([...page.items, ...second.items].map((row: { id: string }) => row.id))).toEqual(new Set(["database-a", "database-b"]));
    expect(second.nextCursor).toBeNull();
    expect(page.items[0]).not.toHaveProperty("collateralAccountId");
  });
  it.each(["chain-open", "chain-draft", "database-draft"])("hides %s in legacy public detail", async (slug) => {
    const response = await detail(request(`/api/markets/${slug}`), { params: Promise.resolve({ slug }) });
    expect(response.status).toBe(404);
  });
  it.each([
    ["search", () => search(request("/api/search?q=Forecast"))],
    ["calendar", () => calendar(request("/api/calendar"))],
  ] as const)("%s omits chain and draft prices", async (_name, get) => {
    const response = await get(); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.markets.map((row: { id: string }) => row.id).sort()).toEqual(["database-a", "database-b"]);
    expect(body.markets.every((row: object) => !("collateralAccountId" in row))).toBe(true);
  });
  it("discovery counts only database event membership", async () => {
    const response = await discovery(); expect(response.status).toBe(200);
    const body = await response.json();
    for (const key of ["trending", "newest", "closingSoon"]) expect(body[key].map((row: { id: string }) => row.id).sort()).toEqual(["database-a", "database-b"]);
    expect(body.featuredEvents.map((row: { id: string; marketCount: number }) => [row.id, row.marketCount])).toEqual([["mixed", 2]]);
  });
  it("events retain eligible database members and hide chain-only events", async () => {
    const events = await listPublicEvents(db, { timing: "all", limit: 10 });
    expect(events.items.map(event => event.id)).toEqual(["mixed"]);
    expect(events.items[0].markets.map(market => market.id).sort()).toEqual(["database-a", "database-b"]);
    expect(await getPublicEvent(db, "chain-only")).toBeNull();
  });
  it("excludes contaminated chain activity/positions from SQL history and rankings", async () => {
    await db.$transaction(async tx => {
      expect((await loadPublicTradeActivity(tx)).map(item => item.market.slug)).toEqual(["database-a"]);
      expect((await loadTradeHistory(tx, "reader", { limit: 20 })).items.map(item => item.market.slug)).toEqual(["database-a"]);
      expect((await loadTradingActivity(tx, ["reader"])).get("reader")).toEqual({ trades: 1, marketsTraded: 1 });
    });
    const players = await getLeaderboardRows();
    expect(players[0]).toMatchObject({ trades: 1, marketsTraded: 1, equityMilli: 0n });
    expect((await listUserFills({ userId: "reader", limit: 10 })).fills).toEqual([]);
    await expect(listPublicTrades({ marketSlug: "chain-open", limit: 10 })).rejects.toMatchObject({ code: "MARKET_BACKEND_MISMATCH" });
  });
  it("keeps shared comments/watchlists and chain identity untouched", async () => {
    const chain = await db.market.findUniqueOrThrow({ where: { id: "chain-open" } });
    await expect(db.$transaction(tx => loadMarketMarks(tx, [chain]))).rejects.toMatchObject({ code: "MARKET_BACKEND_MISMATCH" });
    expect(await db.watchlistEntry.count({ where: { marketId: chain.id } })).toBe(1);
    expect(await db.comment.count({ where: { marketId: chain.id } })).toBe(1);
    expect(await db.market.findUniqueOrThrow({ where: { id: chain.id } })).toEqual(chain);
  });
});
