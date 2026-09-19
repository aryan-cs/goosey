import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile), cleanup: string[] = [];
const migration = "prisma/sqlite-upgrades/20260919233000_market_execution_backend.sql";
let priorSql: string;
async function directory() { const value = await mkdtemp(join(tmpdir(), "goosey-market-backend-")); cleanup.push(value); return value; }
async function sqlite(database: string, sql: string) {
  const { stdout } = await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", database,
    `PRAGMA foreign_keys=ON;\n${sql}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
  return stdout.trim();
}
beforeAll(async () => {
  const source = (await readFile("prisma/schema.prisma", "utf8"))
    .replace(/model SolanaMarketBinding \{[\s\S]*?^\}/m, "")
    .replace(/^  executionBackend\s+String.*\n/m, "")
    .replace(/^  solanaBinding\s+SolanaMarketBinding\?.*\n/m, "")
    .replace(/^  @@index\(\[executionBackend, status, closesAt\]\).*\n/m, "")
    .replace(/collateralAccountId String\?/, "collateralAccountId String")
    .replace(/collateralAccount   LedgerAccount\?/, "collateralAccount   LedgerAccount");
  const schema = join(await directory(), "prior.prisma"); await writeFile(schema, source);
  priorSql = (await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty",
    "--to-schema-datamodel", schema, "--script"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })).stdout;
}, 30000);
afterEach(async () => {
  // beforeAll's schema is no longer needed after DDL was generated.
  for (const value of cleanup.splice(0)) await rm(value, { recursive: true, force: true });
});

// Deliberately isolated migration fixtures, never inserted into participant/shared databases.
const rows = `
INSERT INTO "User" (id,email,username,displayName,passwordHash,balanceMilli,updatedAt)
 VALUES ('u','u@example.invalid','u','User','fixture',9007199254740993,'2026-09-19 12:00:00');
INSERT INTO "LedgerAccount" (id,ownerType,ownerId,purpose,balanceMilli,updatedAt)
 VALUES ('collateral','MARKET','m','COLLATERAL',9007199254740993,'2026-09-19 12:00:00'),
 ('cash','USER','u','AVAILABLE',-9007199254740993,'2026-09-19 12:00:00');
INSERT INTO "Market" (id,slug,title,shortTitle,description,rules,resolutionSource,category,closesAt,resolvesAt,
 createdById,collateralAccountId,updatedAt,pricingModel,yesShares,noShares,payoutMilli,feeBps,volumeMilli,bookSequence,commandSequence,tradeSequence)
 VALUES ('m','legacy','Legacy','Legacy','description','rules','source','OTHER','2026-10-01','2026-10-02','u','collateral',
 '2026-09-19 12:00:00','ORDER_BOOK',12,34,100000,35,9007199254740993,9007199254740994,9007199254740995,9007199254740996);
INSERT INTO "Position" (id,userId,marketId,yesShares,noShares,netCostMilli,updatedAt)
 VALUES ('p','u','m',12,34,9007199254740993,'2026-09-19 12:00:00');
INSERT INTO "Trade" (id,userId,marketId,side,action,quantity,amountMilli,priceBeforeBps,priceAfterBps,idempotencyKey)
 VALUES ('t','u','m','YES','BUY',12,9007199254740993,4500,4600,'prior-trade');
INSERT INTO "JournalEntry" (id,type,referenceType,referenceId,idempotencyScope,idempotencyKey)
 VALUES ('j','TEST','MARKET','m','migration','prior-entry');
INSERT INTO "LedgerPosting" (id,journalEntryId,ledgerAccountId,amountMilli)
 VALUES ('post-a','j','collateral',9007199254740993),('post-b','j','cash',-9007199254740993);
INSERT INTO "MarketOrder" (id,userId,marketId,clientOrderId,outcome,action,bookSide,limitPriceMilli,
 originalQuantity,remainingQuantity,stpOwnerId,acceptedSequence,prioritySequence,orderChainId,updatedAt)
 VALUES ('o','u','m','client-order','YES','BUY','BUY',45000,2,2,'u',4,5,'chain','2026-09-19 12:00:00');
INSERT INTO "Comment" (id,userId,marketId,body,updatedAt) VALUES ('comment','u','m','retained','2026-09-19 12:00:00');
INSERT INTO "Comment" (id,userId,marketId,parentId,body,updatedAt) VALUES ('reply','u','m','comment','reply','2026-09-19 12:00:00');
INSERT INTO "WatchlistEntry" (id,userId,marketId) VALUES ('watch','u','m');
INSERT INTO "MarketResolutionProposal" (id,marketId,proposerId,outcome,reason,evidence,idempotencyKey,requestHash)
 VALUES ('proposal','m','u','YES','reason','evidence','proposal-key','request-hash');
INSERT INTO "MarketSettlementRun" (id,marketId,proposalId,outcome,reason,evidence,approvedById,approvalIdempotencyKey,
 approvalRequestHash,totalPositions,updatedAt) VALUES ('run','m','proposal','YES','reason','evidence','u','approval-key','approval-hash',1,'2026-09-19 12:00:00');
`;
async function database(schemaSql = priorSql) {
  const file = join(await directory(), "prior.db"); await sqlite(file, schemaSql + rows); return file;
}
async function upgrade(file: string) { return sqlite(file, await readFile(migration, "utf8")); }
const market = (id: string, backend = "SOLANA", collateral = "NULL") => `INSERT INTO "Market"
 (id,slug,title,shortTitle,description,rules,resolutionSource,category,closesAt,resolvesAt,createdById,collateralAccountId,updatedAt,executionBackend)
 VALUES ('${id}','${id}','Chain','Chain','description','rules','source','OTHER','2026-10-01','2026-10-02','u',${collateral},'2026-09-19 12:00:00','${backend}');`;
const binding = (id = "bind", marketId = "s", chainMarketId = "18446744073709551615", marketAddress = "market-address") => `
 INSERT INTO "SolanaMarketBinding" (id,marketId,cluster,genesisHash,programAddress,marketAddress,chainMarketId)
 VALUES ('${id}','${marketId}','localnet','genesis','program','${marketAddress}','${chainMarketId}');`;

describe("reviewed market backend migration (actual disposable SQLite, no client generation)", () => {
  it("preserves every legacy value, index and child relation while defaulting existing markets to DATABASE", async () => {
    const file = await database();
    const names = (await sqlite(file, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`)).split("\n");
    const columns = new Map<string, string[]>();
    for (const name of names) columns.set(name, (await sqlite(file, `SELECT name FROM pragma_table_info('${name}') ORDER BY cid;`)).split("\n"));
    const snapshot = async () => {
      const result: string[] = [];
      for (const name of names) result.push(await sqlite(file, `SELECT ${columns.get(name)!.map(c => `quote("${c}")`).join(" || '|' || ")} FROM "${name}" ORDER BY rowid;`));
      return result;
    };
    const before = await snapshot();
    const indexes = await sqlite(file, `SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name;`);
    const otherDefinitions = await sqlite(file, `SELECT name,sql FROM sqlite_master WHERE type='table' AND name!='Market' ORDER BY name;`);
    await upgrade(file);
    expect(await snapshot()).toEqual(before);
    expect(await sqlite(file, `SELECT executionBackend,collateralAccountId FROM "Market";`)).toBe("DATABASE|collateral");
    expect(await sqlite(file, `SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL
      AND name NOT LIKE 'SolanaMarketBinding_%' AND name!='Market_executionBackend_status_closesAt_idx' ORDER BY name;`)).toBe(indexes);
    expect(await sqlite(file, `SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT IN ('Market','SolanaMarketBinding') ORDER BY name;`)).toBe(otherDefinitions);
    expect(await sqlite(file, "PRAGMA foreign_key_check;")).toBe("");
    expect(await sqlite(file, "PRAGMA integrity_check;")).toBe("ok");
    await expect(upgrade(file)).rejects.toThrow(/CHECK/);
    expect(await snapshot()).toEqual(before);
  }, 30000);

  it("creates shared SOLANA catalog IDs with no collateral and retains comments/watchlist compatibility", async () => {
    const file = await database(); await upgrade(file);
    await sqlite(file, `BEGIN; ${market("s")}${binding()}
      INSERT INTO "Comment" (id,userId,marketId,body,updatedAt) VALUES ('chain-comment','u','s','chain comment',CURRENT_TIMESTAMP);
      INSERT INTO "WatchlistEntry" (id,userId,marketId) VALUES ('chain-watch','u','s'); COMMIT;`);
    expect(await sqlite(file, `SELECT m.id,m.executionBackend,quote(m.collateralAccountId),b.chainMarketId,c.id,w.id
      FROM "Market" m JOIN "SolanaMarketBinding" b ON b.marketId=m.id JOIN "Comment" c ON c.marketId=m.id
      JOIN "WatchlistEntry" w ON w.marketId=m.id WHERE m.id='s';`))
      .toBe("s|SOLANA|NULL|18446744073709551615|chain-comment|chain-watch");
    expect(await sqlite(file, `SELECT count(*) FROM "LedgerAccount";`)).toBe("2");
  });

  it("enforces exact backend/collateral pairing and immutable backend", async () => {
    const file = await database(); await upgrade(file); await sqlite(file, market("s"));
    for (const sql of [market("invalid", "OTHER"), market("missing", "DATABASE"), market("fake", "SOLANA", "'cash'"),
      `UPDATE "Market" SET collateralAccountId=NULL WHERE id='m';`, `UPDATE "Market" SET collateralAccountId='cash' WHERE id='s';`]) {
      await expect(sqlite(file, sql)).rejects.toThrow(/CHECK/);
    }
    for (const sql of [`UPDATE "Market" SET executionBackend='SOLANA',collateralAccountId=NULL WHERE id='m';`,
      `UPDATE "Market" SET executionBackend='DATABASE',collateralAccountId='cash' WHERE id='s';`]) {
      await expect(sqlite(file, sql)).rejects.toThrow(/immutable/);
    }
    await sqlite(file, `UPDATE "Market" SET title='Metadata remains editable',executionBackend='DATABASE' WHERE id='m';`);
    await expect(sqlite(file, binding("bad", "m"))).rejects.toThrow(/requires a SOLANA/);
  });

  it("enforces immutable retained binding, unique local market and domain address/ID", async () => {
    const file = await database(); await upgrade(file); await sqlite(file, market("s") + market("s2") + binding());
    await expect(sqlite(file, binding("duplicate-local", "s", "2", "other"))).rejects.toThrow(/UNIQUE/);
    await expect(sqlite(file, binding("duplicate-address", "s2", "2"))).rejects.toThrow(/UNIQUE/);
    await expect(sqlite(file, binding("duplicate-id", "s2", "18446744073709551615", "other"))).rejects.toThrow(/UNIQUE/);
    for (const field of ["id", "marketId", "cluster", "genesisHash", "programAddress", "marketAddress", "chainMarketId", "createdAt"]) {
      await expect(sqlite(file, `UPDATE "SolanaMarketBinding" SET "${field}"='changed' WHERE id='bind';`)).rejects.toThrow(/immutable/);
    }
    await expect(sqlite(file, `DELETE FROM "SolanaMarketBinding" WHERE id='bind';`)).rejects.toThrow(/retained/);
    await expect(sqlite(file, `DELETE FROM "Market" WHERE id='s';`)).rejects.toThrow(/FOREIGN KEY/);
    await sqlite(file, binding("other-domain", "s2").replace("'genesis'", "'other-genesis'"));
    expect(await sqlite(file, `SELECT count(*) FROM "SolanaMarketBinding";`)).toBe("2");
  });

  it.each(["", "01", "-1", "1e3", "1.0", "18446744073709551616", "100000000000000000000"])("rejects noncanonical/out-of-range chain ID %s", async id => {
    const file = await database(); await upgrade(file); await sqlite(file, market("s"));
    await expect(sqlite(file, binding("b", "s", id))).rejects.toThrow(/CHECK/);
  });

  it.each(["index", "trigger", "column", "orphan"])("refuses unexpected prior %s without losing anything", async extra => {
    const file = await database();
    if (extra === "index") await sqlite(file, `CREATE INDEX "custom_market_index" ON "Market"(title);`);
    if (extra === "trigger") await sqlite(file, `CREATE TRIGGER "custom_market_trigger" AFTER UPDATE ON "Market" BEGIN SELECT 1; END;`);
    if (extra === "column") await sqlite(file, `ALTER TABLE "Market" ADD COLUMN customValue TEXT;`);
    if (extra === "orphan") await sqlite(file, `PRAGMA foreign_keys=OFF; UPDATE "Position" SET marketId='missing';`);
    const before = await sqlite(file, `SELECT type,name,sql FROM sqlite_master ORDER BY type,name;`);
    await expect(upgrade(file)).rejects.toThrow(/CHECK/);
    expect(await sqlite(file, `SELECT type,name,sql FROM sqlite_master ORDER BY type,name;`)).toBe(before);
    expect(await sqlite(file, `SELECT volumeMilli FROM "Market";`)).toBe("9007199254740993");
  });

  it("rolls back a late rebuild failure with children intact", async () => {
    const file = await database();
    await sqlite(file, `CREATE TABLE "SolanaMarketBinding" (sentinel TEXT); INSERT INTO "SolanaMarketBinding" VALUES ('retained');`);
    await expect(upgrade(file)).rejects.toThrow(/already exists/);
    expect(await sqlite(file, `SELECT count(*) FROM "Comment"; SELECT count(*) FROM "WatchlistEntry";
      SELECT volumeMilli FROM "Market"; SELECT sentinel FROM "SolanaMarketBinding";
      SELECT count(*) FROM pragma_table_info('Market') WHERE name='executionBackend';`)).toBe("2\n1\n9007199254740993\nretained\n0");
    expect(await sqlite(file, "PRAGMA foreign_key_check;")).toBe("");
  });

  it.each(["missing", "columns", "uniqueness", "descending", "collation", "partial", "expression"])("rejects recognized-name index drift: %s", async change => {
    const file = await database();
    await sqlite(file, 'DROP INDEX "Market_slug_key";');
    const replacements: Record<string, string> = {
      columns: 'CREATE UNIQUE INDEX "Market_slug_key" ON "Market"(title);',
      uniqueness: 'CREATE INDEX "Market_slug_key" ON "Market"(slug);',
      descending: 'CREATE UNIQUE INDEX "Market_slug_key" ON "Market"(slug DESC);',
      collation: 'CREATE UNIQUE INDEX "Market_slug_key" ON "Market"(slug COLLATE NOCASE);',
      partial: 'CREATE UNIQUE INDEX "Market_slug_key" ON "Market"(slug) WHERE status=\'OPEN\';',
      expression: 'CREATE UNIQUE INDEX "Market_slug_key" ON "Market"(lower(slug));',
    };
    if (change !== "missing") await sqlite(file, replacements[change]);
    const before = await sqlite(file, 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name;');
    await expect(upgrade(file)).rejects.toThrow(/CHECK/);
    expect(await sqlite(file, 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name;')).toBe(before);
    expect(await sqlite(file, 'SELECT count(*) FROM "Position"; SELECT count(*) FROM "MarketOrder";')).toBe("1\n1");
  });

  it.each(["type", "default", "nullability", "foreign-key", "extra-check"])("rejects table source drift: %s", async change => {
    const replacements: Record<string, [string, string]> = {
      type: ['"volumeMilli" BIGINT NOT NULL DEFAULT 0', '"volumeMilli" TEXT NOT NULL DEFAULT 0'],
      default: ['"liquidityParameter" INTEGER NOT NULL DEFAULT 40', '"liquidityParameter" INTEGER NOT NULL DEFAULT 41'],
      nullability: ['"collateralAccountId" TEXT NOT NULL,', '"collateralAccountId" TEXT,'],
      "foreign-key": ['CONSTRAINT "Market_collateralAccountId_fkey" FOREIGN KEY ("collateralAccountId") REFERENCES "LedgerAccount" ("id") ON DELETE RESTRICT',
        'CONSTRAINT "Market_collateralAccountId_fkey" FOREIGN KEY ("collateralAccountId") REFERENCES "LedgerAccount" ("id") ON DELETE CASCADE'],
      "extra-check": ['"volumeMilli" BIGINT NOT NULL DEFAULT 0', '"volumeMilli" BIGINT NOT NULL DEFAULT 0 CHECK ("volumeMilli" >= 0)'],
    };
    const [from, to] = replacements[change]; expect(priorSql).toContain(from);
    const file = await database(priorSql.replace(from, to));
    const before = await sqlite(file, 'SELECT sql FROM sqlite_master WHERE name=\'Market\';');
    await expect(upgrade(file)).rejects.toThrow(/CHECK/);
    expect(await sqlite(file, 'SELECT sql FROM sqlite_master WHERE name=\'Market\';')).toBe(before);
  });

  it.each(["missing-row", "changed-value"])("copy proof aborts before DROP on %s", async change => {
    const file = await database(), source = await readFile(migration, "utf8");
    const damaged = change === "missing-row" ? source.replace(' FROM "Market";', ' FROM "Market" WHERE id != \'m\';')
      : source.replace('SELECT "id", "slug", "title",', 'SELECT "id", "slug", \'corrupted\',');
    expect(damaged).not.toBe(source);
    await expect(sqlite(file, damaged)).rejects.toThrow(/CHECK/);
    expect(await sqlite(file, 'SELECT id,title FROM "Market"; SELECT count(*) FROM "Comment";')).toBe("m|Legacy\n2");
    expect(await sqlite(file, "SELECT count(*) FROM pragma_table_info('Market') WHERE name='executionBackend';")).toBe("0");
  });

  it("documents equivalent PostgreSQL nullable/backend/identity constraints and atomic migration", async () => {
    const source = await readFile("prisma/postgresql/migrations/20260919233000_market_execution_backend/migration.sql", "utf8");
    expect(source).toContain('ALTER COLUMN "collateralAccountId" DROP NOT NULL');
    expect(source).toContain('"executionBackend" TEXT NOT NULL DEFAULT \'DATABASE\'');
    expect(source).toContain('"Market_backend_collateral_check"');
    expect(source).toContain('NEW."executionBackend" IS DISTINCT FROM OLD."executionBackend"');
    expect(source).toContain("'18446744073709551615'");
    expect(source).toContain('FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT');
    expect(source).toContain('"SolanaMarketBinding_domain_address_key"'); expect(source).toContain('"SolanaMarketBinding_domain_id_key"');
    expect(source).toContain('BEGIN;'); expect(source.trim().endsWith('COMMIT;')).toBe(true);
    expect(source).not.toMatch(/UPDATE\s+"(?:Market|User|LedgerAccount)"\s+SET/);
  });
});
