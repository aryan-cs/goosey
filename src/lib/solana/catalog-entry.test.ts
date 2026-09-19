import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { address } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ startup: vi.fn(), findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { market: { findFirst: mocks.findFirst } }, requireDatabaseStartup: mocks.startup }));
vi.mock("@/lib/market-service", () => ({ ApiError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
} }));
import { parseCatalogMarketId, readSolanaCatalogEntry } from "./catalog-entry";
import { deriveGooseyMarketAddresses } from "./escrow-client";

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:1",
  genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q") };
let directory: string, database: PrismaClient, marketId: string, canonical: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "goosey-catalog-entry-"));
  const file = path.join(directory, "isolated.db"), url = `file:${file}`;
  const schema = execFileSync(path.join(process.cwd(), "node_modules/.bin/prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: url }, encoding: "utf8", timeout: 20_000 });
  execFileSync("sqlite3", ["-batch", "-bail", "-init", "/dev/null", file], { input: schema, timeout: 20_000 });
  database = new PrismaClient({ datasourceUrl: url });
  const user = await database.user.create({ data: { email: "entry@example.invalid", username: "entry_fixture",
    displayName: "Isolated test", passwordHash: "unusable-test-only" } });
  canonical = (await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId: 7n })).market;
  const market = await database.market.create({ data: { slug: "isolated-entry", title: "Isolated catalog fixture",
    shortTitle: "Fixture", description: "Database test only, not a chain deployment", rules: "Fixture rules",
    resolutionSource: "https://example.invalid", category: "Tests", closesAt: new Date(), resolvesAt: new Date(),
    createdById: user.id, executionBackend: "SOLANA", acceptingOrders: false,
    solanaBinding: { create: { cluster: runtime.cluster, genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress, chainMarketId: "7", marketAddress: canonical } } } });
  marketId = market.id;
}, 30_000);
beforeEach(async () => {
  vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", "true");
  await database.market.update({ where: { id: marketId }, data: { status: "OPEN", acceptingOrders: false,
    executionBackend: "SOLANA", collateralAccountId: null } });
  await database.solanaMarketBinding.update({ where: { marketId }, data: { cluster: runtime.cluster,
    genesisHash: runtime.genesisHash, programAddress: runtime.programAddress, chainMarketId: "7", marketAddress: canonical } });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await database?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe("real isolated SQLite catalog lookup (no RPC claims)", () => {
  it("returns the exact social identity and editorial allowlist without writing database state", async () => {
    const before = execFileSync("sqlite3", ["-init", "/dev/null", path.join(directory, "isolated.db"), ".dump"], { encoding: "utf8" });
    const item = await readSolanaCatalogEntry(runtime, "7", database);
    expect(item).toMatchObject({ id: marketId, slug: "isolated-entry", chain: { marketId: "7", marketAddress: canonical } });
    expect(Object.keys(item!).sort()).toEqual(["id", "slug", "title", "shortTitle", "description", "rules", "resolutionSource",
      "category", "status", "featured", "color", "icon", "closesAt", "resolvesAt", "createdAt", "updatedAt", "href", "chain"].sort());
    expect(execFileSync("sqlite3", ["-init", "/dev/null", path.join(directory, "isolated.db"), ".dump"], { encoding: "utf8" })).toBe(before);
  });
  it.each([{ status: "DRAFT" }, { status: "RESOLVED" }, { acceptingOrders: true }, { executionBackend: "DATABASE" }])(
    "hides ineligible rows %j", async data => {
      await database.market.update({ where: { id: marketId }, data });
      expect(await readSolanaCatalogEntry(runtime, "7", database)).toBeNull();
    });
  it.each([{ cluster: "devnet" }, { genesisHash: "other-genesis" }, { programAddress: "other-program" },
    { marketAddress: runtime.programAddress }, { chainMarketId: "07" }])("hides mismatched bindings %j", async data => {
      await database.solanaMarketBinding.update({ where: { marketId }, data });
      expect(await readSolanaCatalogEntry(runtime, "7", database)).toBeNull();
    });
  it("hides a row backed by SQL collateral", async () => {
    const collateral = await database.ledgerAccount.create({ data: { ownerType: "TEST", purpose: "TEST_COLLATERAL" } });
    await database.market.update({ where: { id: marketId }, data: { collateralAccountId: collateral.id } });
    expect(await readSolanaCatalogEntry(runtime, "7", database)).toBeNull();
  });
  it("hides a missing binding", async () => {
    const binding = await database.solanaMarketBinding.delete({ where: { marketId } });
    try { expect(await readSolanaCatalogEntry(runtime, "7", database)).toBeNull(); }
    finally { await database.solanaMarketBinding.create({ data: binding }); }
  });
  it("returns null for absent IDs and does not round large u64 IDs", async () => {
    expect(await readSolanaCatalogEntry(runtime, "8", database)).toBeNull();
    const id = "18446744073709551615";
    const pda = await deriveGooseyMarketAddresses({ programAddress: runtime.programAddress, marketId: BigInt(id) });
    await database.solanaMarketBinding.update({ where: { marketId }, data: { chainMarketId: id, marketAddress: pda.market } });
    expect((await readSolanaCatalogEntry(runtime, id, database))?.chain.marketId).toBe(id);
  });
  it.each(["", "01", "-1", "+1", "1e3", "1.0", "18446744073709551616"])("rejects invalid ID %s", value => {
    expect(() => parseCatalogMarketId(value)).toThrow(expect.objectContaining({ status: 400 }));
  });
  it.each([undefined, "false", "TRUE", "1"])("requires exact gate %s", async value => {
    vi.stubEnv("GOOSEY_SOLANA_CATALOG_ENABLED", value);
    await expect(readSolanaCatalogEntry(runtime, "7", database)).rejects.toMatchObject({ status: 503 });
  });
  it("fails before default-client SQL when startup fails", async () => {
    mocks.startup.mockRejectedValue(new Error("startup refused"));
    await expect(readSolanaCatalogEntry(runtime, "7")).rejects.toThrow("startup refused");
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});
