import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cleanup: string[] = [];
const migrationName = "20260919220000_solana_event_journal";
const modelNames = ["SolanaIngestionCursor", "SolanaTransactionReceipt", "SolanaProgramEvent"];
const sqlitePath = `prisma/sqlite-upgrades/${migrationName}.sql`;
const postgresPath = `prisma/postgresql/migrations/${migrationName}/migration.sql`;

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "goosey-event-journal-migration-"));
  cleanup.push(directory);
  return directory;
}

async function sqlite(database: string, statement: string) {
  const { stdout } = await execute("sqlite3", [
    "-batch", "-bail", "-init", process.platform === "win32" ? "NUL" : "/dev/null",
    database, `PRAGMA foreign_keys=ON;\n${statement}`,
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function upgrade(database: string) {
  await sqlite(database, `BEGIN IMMEDIATE;\n${await readFile(sqlitePath, "utf8")}\nCOMMIT;`);
}

async function schemaSql(schema: string) {
  const { stdout } = await execute(process.execPath, [
    "node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty",
    "--to-schema-datamodel", schema, "--script",
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function freshJournal() {
  const database = join(await temporaryDirectory(), "journal.db");
  await upgrade(database);
  return database;
}

const cursorInsert = `INSERT INTO "SolanaIngestionCursor"
  (id, genesisHash, programAddress, coverageStartSignature, updatedAt)
  VALUES ('cursor', 'genesis', 'program', 'start', CURRENT_TIMESTAMP);`;
const receiptInsert = `INSERT INTO "SolanaTransactionReceipt"
  (id, genesisHash, programAddress, signature, slot, updatedAt)
  VALUES ('receipt', 'genesis', 'program', 'signature', 9223372036854775807, CURRENT_TIMESTAMP);`;
const eventInsert = `INSERT INTO "SolanaProgramEvent"
  (eventKey, receiptId, logIndex, invocationDepth, kind, payload)
  VALUES ('genesis:program:signature:3', 'receipt', 3, 1, 'TradeExecuted',
    '{"quantity":"18446744073709551615"}');`;

afterEach(async () => {
  for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("additive finalized Solana event journal migrations", () => {
  it.each([
    ["SQLite", "prisma/schema.prisma", sqlitePath],
    ["PostgreSQL", "prisma/postgresql/schema.prisma", postgresPath],
  ])("matches %s schema-generated DDL without touching financial tables", async (_provider, schema, migration) => {
    const generated = await schemaSql(schema);
    const journalStatements = generated.split(";").filter((statement) =>
      /(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE) "(?:SolanaIngestionCursor|SolanaTransactionReceipt|SolanaProgramEvent|SolanaCursor_|SolanaReceipt_)/.test(statement));
    const normalize = (source: string) => source.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
    const actual = await readFile(migration, "utf8");
    expect(normalize(actual)).toBe(normalize(`${journalStatements.join(";")};`));
    expect(actual).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP)\s+(?:INTO|FROM|TABLE)?\s*"(?:User|Market|LedgerAccount|LedgerPosting|JournalEntry)"/i);
    expect(actual.match(/REFERENCES "([^"]+)"/g)).toEqual(['REFERENCES "SolanaTransactionReceipt"']);
  });

  it("preserves the full prior SQLite schema and populated legacy ledger/auth records", async () => {
    const directory = await temporaryDirectory();
    const database = join(directory, "prior.db");
    let prior = await readFile("prisma/schema.prisma", "utf8");
    for (const name of modelNames) prior = prior.replace(new RegExp(`model ${name} \\{[\\s\\S]*?^\\}`, "m"), "");
    const priorPath = join(directory, "prior.prisma");
    await writeFile(priorPath, prior);
    await sqlite(database, await schemaSql(priorPath));
    // Explicit SQL fixtures are confined to this disposable migration test database.
    await sqlite(database, `
      INSERT INTO "User" (id,email,username,displayName,passwordHash,balanceMilli,updatedAt)
        VALUES ('u','migration@example.invalid','migration','Migration','test-only',9007199254740993,CURRENT_TIMESTAMP);
      INSERT INTO "Session" (id,tokenHash,userId,expiresAt)
        VALUES ('s','test-only','u','2026-09-20');
      INSERT INTO "LedgerAccount" (id,ownerType,ownerId,purpose,balanceMilli,updatedAt)
        VALUES ('a','USER','u','AVAILABLE',9007199254740993,CURRENT_TIMESTAMP),
        ('b','SYSTEM',NULL,'ISSUANCE',-9007199254740993,CURRENT_TIMESTAMP);
      INSERT INTO "JournalEntry" (id,type,referenceType,referenceId,idempotencyScope,idempotencyKey)
        VALUES ('j','GRANT','TEST','u','migration','one');
      INSERT INTO "LedgerPosting" (id,journalEntryId,ledgerAccountId,amountMilli)
        VALUES ('p1','j','a',9007199254740993),('p2','j','b',-9007199254740993);
    `);
    const names = await sqlite(database, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`);
    const snapshot = async () => {
      const result: string[] = [];
      for (const name of names.split("\n")) {
        const columns = await sqlite(database, `SELECT name FROM pragma_table_info('${name}') ORDER BY cid;`);
        const expressions = columns.split("\n").map((column) => `quote("${column}")`).join(" || '|' || ");
        result.push(await sqlite(database, `SELECT ${expressions} FROM "${name}" ORDER BY rowid;`));
      }
      result.push(await sqlite(database, `SELECT type,name,tbl_name,sql FROM sqlite_master
        WHERE tbl_name NOT IN ('${modelNames.join("','")}') ORDER BY type,name;`));
      return result;
    };
    const before = await snapshot();
    await upgrade(database);
    expect(await snapshot()).toEqual(before);
    expect(await sqlite(database, "PRAGMA foreign_key_check;")).toBe("");
    expect(await sqlite(database, "PRAGMA integrity_check;")).toBe("ok");
    await expect(upgrade(database)).rejects.toThrow(/already exists/i);
    expect(await snapshot()).toEqual(before);
  }, 30_000);

  it("stores signed-max slots and full-u64 payloads exactly, with successful zero-event receipts", async () => {
    const database = await freshJournal();
    await sqlite(database, `${receiptInsert}
      UPDATE "SolanaTransactionReceipt" SET status='VERIFIED_SUCCESS', configurationSlot=slot;
    `);
    expect(await sqlite(database, `SELECT slot,configurationSlot,status,eventCount,decoderVersion
      FROM "SolanaTransactionReceipt";`)).toBe("9223372036854775807|9223372036854775807|VERIFIED_SUCCESS|0|1");
    await sqlite(database, eventInsert);
    expect(await sqlite(database, `SELECT payload,schemaVersion FROM "SolanaProgramEvent";`))
      .toBe('{"quantity":"18446744073709551615"}|1');
    // SQL BIGINT is not an unsigned validator (SQLite can coerce overflow to REAL).
    // Every writer must reject negative or > signed-max values BEFORE Prisma writes.
    for (const schema of ["prisma/schema.prisma", "prisma/postgresql/schema.prisma"]) {
      expect(await readFile(schema, "utf8")).toContain("0 <= slot <= 9223372036854775807");
    }
  });

  it("deduplicates transaction identities per network/program and event identities per log position", async () => {
    const database = await freshJournal();
    await sqlite(database, `${receiptInsert}${eventInsert}`);
    await expect(sqlite(database, receiptInsert.replace("'receipt'", "'duplicate'"))).rejects.toThrow(/UNIQUE/);
    await sqlite(database, receiptInsert.replace("'receipt'", "'other-network'").replace("'genesis'", "'other-genesis'"));
    await sqlite(database, receiptInsert.replace("'receipt'", "'other-program'").replace("'program'", "'other-program'"));
    await expect(sqlite(database, eventInsert)).rejects.toThrow(/UNIQUE/);
    await expect(sqlite(database, eventInsert.replace("signature:3'", "signature:4'"))).rejects.toThrow(/UNIQUE/);
    await expect(sqlite(database, eventInsert.replaceAll("'receipt'", "'absent'")
      .replace("signature:3'", "signature:5'"))).rejects.toThrow(/FOREIGN KEY/);
    await expect(sqlite(database, `DELETE FROM "SolanaTransactionReceipt" WHERE id='receipt';`)).rejects.toThrow(/FOREIGN KEY/);
  });

  it("supports durable scan resume, cursor revision CAS and all-or-nothing journal/cursor batches", async () => {
    const database = await freshJournal();
    await sqlite(database, cursorInsert);
    await expect(sqlite(database, cursorInsert.replace("'cursor'", "'duplicate'"))).rejects.toThrow(/UNIQUE/);
    expect(await sqlite(database, `SELECT backfillComplete,revision FROM "SolanaIngestionCursor";`)).toBe("0|0");
    await sqlite(database, `UPDATE "SolanaIngestionCursor" SET scanHeadSignature='head',
      scanBeforeSignature='page-tail',revision=revision+1 WHERE id='cursor' AND revision=0;`);
    expect(await sqlite(database, `UPDATE "SolanaIngestionCursor" SET revision=revision+1
      WHERE id='cursor' AND revision=0; SELECT changes();`)).toBe("0");
    await expect(sqlite(database, `BEGIN IMMEDIATE; ${receiptInsert}${eventInsert}
      UPDATE "SolanaIngestionCursor" SET committedHeadSignature='head',revision=revision+1;
      ${eventInsert} COMMIT;`)).rejects.toThrow(/UNIQUE/);
    expect(await sqlite(database, `SELECT COUNT(*) FROM "SolanaTransactionReceipt";
      SELECT COUNT(*) FROM "SolanaProgramEvent";
      SELECT quote(committedHeadSignature),scanHeadSignature,scanBeforeSignature,revision FROM "SolanaIngestionCursor";`))
      .toBe("0\n0\nNULL|head|page-tail|1");
    await sqlite(database, `BEGIN IMMEDIATE; ${receiptInsert}${eventInsert}
      UPDATE "SolanaTransactionReceipt" SET status='VERIFIED_SUCCESS',eventCount=1;
      UPDATE "SolanaIngestionCursor" SET committedHeadSignature='head',scanHeadSignature=NULL,
        scanBeforeSignature=NULL,backfillComplete=true,revision=revision+1 WHERE revision=1; COMMIT;`);
    expect(await sqlite(database, `SELECT committedHeadSignature,backfillComplete,revision FROM "SolanaIngestionCursor";`))
      .toBe("head|1|2");
  });

  it("rolls back a partially applied migration when a later new table conflicts", async () => {
    const database = join(await temporaryDirectory(), "conflict.db");
    await sqlite(database, `CREATE TABLE "SolanaProgramEvent" (sentinel TEXT);
      INSERT INTO "SolanaProgramEvent" VALUES ('preserve');`);
    await expect(upgrade(database)).rejects.toThrow(/already exists/i);
    expect(await sqlite(database, `SELECT name FROM sqlite_master WHERE type='table';
      SELECT sentinel FROM "SolanaProgramEvent";`)).toBe("SolanaProgramEvent\npreserve");
  });
});
