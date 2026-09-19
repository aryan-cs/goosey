import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ read: vi.fn(), terms: vi.fn(), genesis: vi.fn() }));
// Never instantiate/use the application's shared DB. Only the explicit real
// Prisma client below may reach storage; omission of injection fails closed.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
vi.mock("./escrow-read", () => ({ readGooseyEscrow: boundary.read }));
vi.mock("./market-terms-store", () => ({ readRetainedMarketTerms: boundary.terms }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: boundary.genesis }) }) }));
import { publishSolanaMarket, registerSolanaMarket } from "./market-catalog";
import { readSolanaCatalog } from "./catalog-read";
import { deriveGooseyMarketAddresses } from "./escrow-client";

const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesis = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const secondAddress = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// MOCKED verified-reader/store boundary fixtures, not accounts or manifests
// presented as actual chain execution. Tests below prove real SQLite service
// transactions using the generated Prisma client, NOT RPC/PDA/terms verification.
const snapshot = () => ({ config: program, market: program, featherMint: program, finalizedSlot: 123n,
  marketState: { creator: program, payoutMilli: 1000n, feeBps: 25, closesAt: 2_000_000_000n, resolvesAt: 2_000_000_010n },
  marketTerms: { sealed: true, acceptanceBits: 3, digest: new Uint8Array(32).fill(3), manifestLength: 1000,
    proposer: { wallet: program, enrollment: program }, approver: { wallet: secondAddress, enrollment: secondAddress } },
  orderBook: {}, resolution: { phase: 0 } });
const retained = () => ({ digest: "03".repeat(32), terms: { question: "Offline catalog integration fixture question?",
  rules: { yes: "Offline fixture YES criterion.", no: "Offline fixture NO criterion.", void: "Offline fixture VOID criterion." },
  sources: [{ uri: "https://example.invalid/catalog-fixture" }] } });
let directory: string | undefined, database: PrismaClient | undefined, adminId: string;
function db() { if (!database) throw new Error("Isolated test DB not initialized"); return database; }
const input = () => ({ actorUserId: adminId, runtime: { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:1",
  programAddress: program, genesisHash: genesis }, termsDirectory: "/offline-mocked-store-not-accessed", chainMarketId: 7n,
  metadata: { slug: "isolated-chain-catalog", shortTitle: "Offline catalog fixture",
    description: "Isolated database integration fixture, not a published market.", category: "Tests" } });
async function financialState() {
  const d = db();
  return {
    users: await d.user.findMany({ orderBy: { id: "asc" }, select: { id: true, balanceMilli: true, realizedPnlMilli: true } }),
    accounts: await d.ledgerAccount.findMany(), positions: await d.position.findMany(), orders: await d.marketOrder.findMany(),
    fills: await d.orderFill.findMany(), orderEvents: await d.orderEvent.findMany(), commands: await d.orderCommand.findMany(),
    reservations: await d.orderReservation.findMany(), trades: await d.trade.findMany(), quotes: await d.tradeQuote.findMany(),
    settlements: await d.positionSettlement.findMany(), settlementRuns: await d.marketSettlementRun.findMany(),
    journals: await d.journalEntry.findMany(), postings: await d.ledgerPosting.findMany(),
  };
}
async function catalogState() {
  return { markets: await db().market.findMany({ orderBy: { id: "asc" } }),
    bindings: await db().solanaMarketBinding.findMany({ orderBy: { id: "asc" } }),
    audits: await db().auditLog.findMany({ orderBy: { id: "asc" } }) };
}
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "goosey-catalog-integration-"));
  const file = path.join(directory, "catalog.db"), url = `file:${file}`;
  // No process.env mutation; schema subprocess receives a fresh, explicit DB URL
  // and cannot inherit PostgreSQL or developer database connection settings.
  const schema = execFileSync(path.join(process.cwd(), "node_modules/.bin/prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
    { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, encoding: "utf8", stdio: "pipe", timeout: 20_000 });
  execFileSync("sqlite3", ["-batch", "-bail", "-init", "/dev/null", file], { input: schema, stdio: "pipe", timeout: 20_000 });
  database = new PrismaClient({ datasourceUrl: url }); await database.$connect();
  const admin = await database.user.create({ data: { email: "catalog-admin@example.invalid", username: "catalog_admin",
    displayName: "Isolated Catalog Administrator", passwordHash: "unusable-test-only-no-login", role: "ADMIN", status: "ACTIVE", emailVerifiedAt: new Date() } });
  adminId = admin.id;
  boundary.read.mockResolvedValue(snapshot()); boundary.terms.mockResolvedValue(retained()); boundary.genesis.mockResolvedValue(genesis);
}, 30_000);
afterEach(async () => {
  try { await database?.$disconnect(); }
  finally { database = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = undefined; }
});

describe("catalog registration with real isolated SQLite and mocked chain/store boundaries", () => {
  it("actual discovery hides drafts, exposes published canonical links, and never returns SQL financial defaults", async () => {
    const request = input();
    const canonical = await deriveGooseyMarketAddresses({ programAddress: program, marketId: request.chainMarketId });
    boundary.read.mockResolvedValue({ ...snapshot(), market: canonical.market });
    await registerSolanaMarket(request, db());
    expect(await readSolanaCatalog(request.runtime, { limit: 25 }, db())).toEqual({ items: [], hasMore: false, nextCursor: null });
    await publishSolanaMarket(request, db());
    const result = await readSolanaCatalog(request.runtime, { limit: 25 }, db());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ href: "/chain/markets/7", title: retained().terms.question,
      chain: { marketId: "7", marketAddress: canonical.market, programAddress: program, genesisHash: genesis } });
    for (const key of ["volumeMilli", "yesShares", "noShares", "probabilityYesBps", "collateralAccountId", "balanceMilli", "acceptingOrders"]) {
      expect(result.items[0]).not.toHaveProperty(key);
    }
    expect(await readSolanaCatalog({ ...request.runtime, genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE" }, { limit: 25 }, db()))
      .toEqual({ items: [], hasMore: false, nextCursor: null });
  });
  it("actual catalog pagination preserves same-time rows without duplicates", async () => {
    for (const id of [7n, 8n, 9n]) {
      const request = input(); request.chainMarketId = id; request.metadata.slug = `isolated-market-${id}`;
      const canonical = await deriveGooseyMarketAddresses({ programAddress: program, marketId: id });
      boundary.read.mockResolvedValue({ ...snapshot(), market: canonical.market });
      await registerSolanaMarket(request, db()); await publishSolanaMarket(request, db());
    }
    await db().market.updateMany({ data: { createdAt: new Date("2026-01-01T00:00:00.000Z") } });
    const request = input(), financial = await financialState();
    const first = await readSolanaCatalog(request.runtime, { limit: 2 }, db());
    expect(first.items).toHaveLength(2); expect(first.hasMore).toBe(true); expect(first.nextCursor).toBeTruthy();
    const second = await readSolanaCatalog(request.runtime, { limit: 2, cursor: first.nextCursor! }, db());
    expect(second.items).toHaveLength(1); expect(second.hasMore).toBe(false); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map(row => row.chain.marketId)).size).toBe(3);
    expect(await financialState()).toEqual(financial);
  });
  it("publishes only an existing exact verified entry and replays without duplicate writes", async () => {
    const registered = await registerSolanaMarket(input(), db());
    const financial = await financialState();
    const result = await publishSolanaMarket(input(), db());
    expect(result.market).toMatchObject({ id: registered.market.id, status: "OPEN", acceptingOrders: false,
      executionBackend: "SOLANA", collateralAccountId: null, version: registered.market.version + 1 });
    const state = await catalogState(); expect(state.audits).toHaveLength(2);
    expect(state.audits.some(audit => audit.action === "PUBLISH_SOLANA_CATALOG")).toBe(true);
    expect(await financialState()).toEqual(financial);
    await publishSolanaMarket(input(), db());
    expect(await catalogState()).toEqual(state); expect(await financialState()).toEqual(financial);
  });
  it("publication does not implicitly register an unknown market", async () => {
    await expect(publishSolanaMarket(input(), db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_NOT_REGISTERED" });
    expect(await catalogState()).toEqual({ markets: [], bindings: [], audits: [] });
  });
  it("failed publication audit rolls back visibility and version atomically", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState(), financial = await financialState();
    await db().$executeRawUnsafe('CREATE TRIGGER reject_publish_audit BEFORE INSERT ON "AuditLog" WHEN NEW.action = \'PUBLISH_SOLANA_CATALOG\' BEGIN SELECT RAISE(ABORT, \'isolated publish audit failure\'); END');
    await expect(publishSolanaMarket(input(), db())).rejects.toThrow();
    expect(await catalogState()).toEqual(before); expect(await financialState()).toEqual(financial);
  });
  it("publication rechecks terms and rejects changed registered metadata", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState();
    boundary.terms.mockResolvedValue({ ...retained(), terms: { ...retained().terms, question: "Conflicting mocked commitment?" } });
    await expect(publishSolanaMarket(input(), db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(await catalogState()).toEqual(before);
  });
  it.each([{ status: "CLOSED", acceptingOrders: false }, { status: "DRAFT", acceptingOrders: true }])("does not reinterpret incompatible catalog state %s", async state => {
    const registered = await registerSolanaMarket(input(), db());
    await db().market.update({ where: { id: registered.market.id }, data: state });
    const before = await catalogState();
    await expect(publishSolanaMarket(input(), db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_STATE_CONFLICT" });
    expect(await catalogState()).toEqual(before);
  });
  it("revoked publication session prevents visibility and audit updates", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState();
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked session"));
    await expect(publishSolanaMarket({ ...input(), authorize }, db())).rejects.toThrow("revoked session");
    expect(await catalogState()).toEqual(before);
  });
  it("creates exactly a hidden SOLANA draft, binding and audit with no financial writes", async () => {
    const before = await financialState(); const result = await registerSolanaMarket(input(), db());
    expect(result.created).toBe(true);
    const state = await catalogState(); expect(state.markets).toHaveLength(1); expect(state.bindings).toHaveLength(1); expect(state.audits).toHaveLength(1);
    expect(state.markets[0]).toMatchObject({ id: result.market.id, createdById: adminId, executionBackend: "SOLANA", status: "DRAFT",
      collateralAccountId: null, acceptingOrders: false, pricingModel: "ORDER_BOOK", title: retained().terms.question,
      slug: input().metadata.slug, payoutMilli: 1000n, feeBps: 25, volumeMilli: 0n, yesShares: 0, noShares: 0,
      rules: "YES: Offline fixture YES criterion.\n\nNO: Offline fixture NO criterion.\n\nVOID: Offline fixture VOID criterion.",
      resolutionSource: "https://example.invalid/catalog-fixture", closesAt: new Date(2_000_000_000_000), resolvesAt: new Date(2_000_000_010_000) });
    expect(state.bindings[0]).toMatchObject({ marketId: result.market.id, cluster: "localnet", genesisHash: genesis,
      programAddress: program, marketAddress: program, chainMarketId: "7" });
    expect(state.audits[0]).toMatchObject({ actorUserId: adminId, action: "REGISTER_SOLANA_MARKET", entityType: "MARKET", entityId: result.market.id });
    expect(JSON.parse(state.audits[0].metadata)).toEqual({ cluster: "localnet", genesisHash: genesis, programAddress: program,
      marketAddress: program, chainMarketId: "7", digest: "03".repeat(32), finalizedSlot: "123", visibility: "DRAFT", financialLedgerCreated: false });
    expect(await financialState()).toEqual(before);
    for (const [key, value] of Object.entries(before)) if (key !== "users") expect(value).toEqual([]);
    expect(before.users).toEqual([{ id: adminId, balanceMilli: 0n, realizedPnlMilli: 0n }]);
  });
  it("repeating the same registration is idempotent with no second audit or updated rows", async () => {
    const first = await registerSolanaMarket(input(), db()), before = await catalogState(), financial = await financialState();
    const second = await registerSolanaMarket(input(), db());
    expect(second.created).toBe(false); expect(second.market.id).toBe(first.market.id); expect(second.binding.id).toBe(first.binding.id);
    expect(await catalogState()).toEqual(before); expect(await financialState()).toEqual(financial);
  });
  it("a conflicting slug rolls back without inserting an orphan binding/audit", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState(), financial = await financialState();
    boundary.read.mockResolvedValue({ ...snapshot(), market: secondAddress });
    await expect(registerSolanaMarket({ ...input(), chainMarketId: 8n }, db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(await catalogState()).toEqual(before); expect(await financialState()).toEqual(financial);
  });
  it("a unique market-address binding collision rolls back the newly inserted Market", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState(), financial = await financialState();
    // Deliberately adversarial mocked reader identity: distinct chain ID with
    // the same address. Real SQLite uniqueness, not a mocked P2002 exception.
    const request = input(); request.chainMarketId = 8n; request.metadata.slug = "different-catalog-slug";
    await expect(registerSolanaMarket(request, db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(await catalogState()).toEqual(before); expect(await financialState()).toEqual(financial);
  });
  it("same chain identity with different metadata conflicts without mutating the original", async () => {
    await registerSolanaMarket(input(), db()); const before = await catalogState();
    const request = input(); request.metadata.description = "A different offline description must not silently replace an existing registration.";
    await expect(registerSolanaMarket(request, db())).rejects.toMatchObject({ code: "CHAIN_CATALOG_CONFLICT" });
    expect(await catalogState()).toEqual(before);
  });
  it("a real failing audit INSERT rolls back both Market and SolanaMarketBinding", async () => {
    const before = await catalogState(), financial = await financialState();
    // Failure injection only in this owned temporary SQLite DB, no mocked ORM
    // transaction/delegate. The audit is the final write after market+binding.
    await db().$executeRawUnsafe('CREATE TRIGGER reject_catalog_audit BEFORE INSERT ON "AuditLog" WHEN NEW.action = \'REGISTER_SOLANA_MARKET\' BEGIN SELECT RAISE(ABORT, \'isolated audit insertion failure\'); END');
    await expect(registerSolanaMarket(input(), db())).rejects.toThrow();
    expect(await catalogState()).toEqual(before); expect(await financialState()).toEqual(financial);
    await db().$executeRawUnsafe('DROP TRIGGER reject_catalog_audit');
    // The same request can succeed after the failure; no half-written catalog remains.
    expect((await registerSolanaMarket(input(), db())).created).toBe(true);
  });
  it("rechecks active administrator in the real database after the mocked asynchronous read", async () => {
    boundary.read.mockImplementationOnce(async () => {
      await db().user.update({ where: { id: adminId }, data: { role: "USER" } }); return snapshot();
    });
    await expect(registerSolanaMarket(input(), db())).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    expect(await catalogState()).toEqual({ markets: [], bindings: [], audits: [] });
  });
});
