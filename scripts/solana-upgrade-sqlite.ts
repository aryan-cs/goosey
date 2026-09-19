/** Additive local SQLite upgrade only. No Prisma singleton, environment DB, or financial DML.
 * Online writers are supported only in WAL mode: backup precedes a bounded
 * BEGIN IMMEDIATE writer lock. Readers continue; writers may briefly get BUSY.
 * The backup predates concurrent writes: NEVER automatically restore it over a live DB.
 */
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { createSqliteBackup } from "./lib/sqlite-backup";

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrations = ["20260919210000_solana_wallet_links", "20260919220000_solana_event_journal",
  "20260919230000_solana_ingestion_visits", "20260919234000_solana_coverage_rotations",
  "20260919235000_app_managed_solana_custody", "20260920001000_registration_devices"] as const;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Entry = { type: string; name: string; tbl_name: string; sql: string | null };
const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type COLLATE BINARY,name COLLATE BINARY";

async function sqlite(source: string, sql: string, readonly = true) {
  try {
    const work = execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", "-json", ...(readonly ? ["-readonly"] : []), source],
      { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    work.child.stdin?.on("error", () => { /* execute reports process failure */ });
    work.child.stdin?.end(`PRAGMA busy_timeout=3000;\n${sql}\n`);
    // busy_timeout emits a result; omit only that first output line.
    return (await work).stdout.split("\n").slice(1).join("\n").trim();
  } catch { throw new Error("SQLite upgrade refused or rolled back (schema mismatch, integrity/foreign-key failure, contention, or bounded runtime exceeded)."); }
}

/** Conservative token comparison: whitespace/comments outside quoted values are
 * insignificant; all identifiers, defaults, CHECKs, FKs and index definitions
 * remain exact. Semantically equivalent alternate DDL may be refused, never adopted.
 */
function canonical(sql: string | null) {
  return sql === null ? null : JSON.stringify((sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g) ?? [])
    .filter(token => !token.startsWith("--") && !token.startsWith("/*")));
}
function same(a: Entry, b: Entry) {
  return a.type === b.type && a.name === b.name && a.tbl_name === b.tbl_name && canonical(a.sql) === canonical(b.sql);
}

export async function upgradeSolanaSqlite(source: string, backupPath: string) {
  for (const value of [source, backupPath]) {
    if (!path.isAbsolute(value) || value.includes("\0")) throw new Error("Explicit absolute source and new backup paths are required.");
  }
  if (!(await lstat(source)).isFile()) throw new Error("Source must be an existing regular SQLite file, not a symlink.");
  // Only reviewed, additive SQL files are executable here; never discover arbitrary scripts.
  const sqlFiles = await Promise.all(migrations.map(name => readFile(path.join(root, "prisma/sqlite-upgrades", `${name}.sql`), "utf8")));
  const references: Entry[][] = [];
  for (const sql of sqlFiles) {
    references.push(JSON.parse(await sqlite(":memory:", `${sql}\n${schema};`, false)) as Entry[]);
  }
  const actual = JSON.parse(await sqlite(source, `${schema};`)) as Entry[];
  const allExpected = references.flat();
  const expectedNames = new Set(allExpected.map(entry => entry.name));
  const tableNames = new Set(allExpected.filter(entry => entry.type === "table").map(entry => entry.name));
  const relevant = actual.filter(entry => expectedNames.has(entry.name) || tableNames.has(entry.tbl_name));
  // Reject additional triggers/indexes on owned tables as well as partial upgrades.
  for (const entry of relevant) {
    const expected = allExpected.find(item => item.name === entry.name && item.type === entry.type);
    if (!expected || !same(entry, expected)) throw new Error(`Existing Solana schema differs from reviewed migrations (${entry.type}); no changes applied.`);
  }
  const pending = references.map((entries, i) => {
    const present = entries.filter(entry => relevant.some(item => item.name === entry.name && item.type === entry.type));
    if (present.length && present.length !== entries.length) throw new Error("Partially applied Solana migration; explicit repair required.");
    return present.length ? null : i;
  }).filter((i): i is number => i !== null);
  if (!actual.some(entry => entry.type === "table" && entry.name === "User")) throw new Error("Expected existing application User table.");
  const mode = JSON.parse(await sqlite(source, "PRAGMA journal_mode;")) as Array<{ journal_mode: string }>;
  if (mode[0]?.journal_mode !== "wal") throw new Error("Online additive upgrade requires existing WAL mode. Stop writers and establish the application's SQLite WAL configuration separately; this runner does not change journal mode.");
  const backup = await createSqliteBackup(source, backupPath);
  // Revalidate the exact entire schema under the same writer lock as all DDL.
  // Any concurrent schema change since discovery aborts, even outside our tables.
  const encoded = JSON.stringify(actual.map(e => [e.type, e.name, e.tbl_name, e.sql]));
  const guard = (condition: string) => `INSERT INTO temp.upgrade_guard VALUES(CASE WHEN (${condition}) THEN 1 ELSE 0 END);`;
  const expectedRows = allExpected.map(e => `(type=${literal(e.type)} AND name=${literal(e.name)} AND tbl_name=${literal(e.tbl_name)})`).join(" OR ");
  await sqlite(source, `
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=FULL;
    BEGIN IMMEDIATE;
    CREATE TEMP TABLE upgrade_guard (ok INTEGER NOT NULL CHECK(ok=1));
    ${guard("(SELECT foreign_keys FROM pragma_foreign_keys)=1")}
    ${guard("(SELECT journal_mode FROM pragma_journal_mode)='wal'")}
    ${guard(`(SELECT json_group_array(json_array(type,name,tbl_name,sql)) FROM (${schema}))=${literal(encoded)}`)}
    ${guard("NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)")}
    ${guard("NOT EXISTS(SELECT 1 FROM pragma_integrity_check WHERE integrity_check <> 'ok')")}
    ${pending.map(i => sqlFiles[i]).join("\n")}
    ${guard(`(SELECT count(*) FROM sqlite_master WHERE ${expectedRows})=${allExpected.length}`)}
    ${guard("NOT EXISTS(SELECT 1 FROM pragma_foreign_key_check)")}
    ${guard("NOT EXISTS(SELECT 1 FROM pragma_integrity_check WHERE integrity_check <> 'ok')")}
    COMMIT;
  `, false);
  return { status: "verified" as const, applied: pending.map(i => migrations[i]), backup,
    writerPolicy: "WAL readers continue; writers wait up to their own busy timeout. Backup is a pre-upgrade snapshot, not an automatic rollback of concurrent writes." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: "string" }, backup: { type: "string" }, help: { type: "boolean" } }, strict: true, allowPositionals: false });
    if (values.help) console.log("Usage: node --import tsx scripts/solana-upgrade-sqlite.ts --source /absolute/app.db --backup /absolute/new-backup.db\nApplies the reviewed additive wallet-link/event-journal/visits/coverage-rotation/custody/registration-device upgrades; notification-preference upgrades are outside scope. Existing WAL required. Backup precedes BEGIN IMMEDIATE; lock acquisition waits at most 3 seconds and the whole schema/check transaction is bounded to 20 seconds. WAL readers continue; writers can receive SQLITE_BUSY if their timeout expires. Stop writers briefly if that interruption is unacceptable. No financial DML. Exact reviewed DDL is required; partial/drifted schemas need explicit repair. Backup predates concurrent writes: never auto-restore it over live state. A failed upgrade retains the new backup, if already created; retry requires another new backup path.");
    else {
      if (!values.source || !values.backup) throw new Error("Explicit --source and --backup required.");
      console.log(JSON.stringify(await upgradeSolanaSqlite(values.source, values.backup)));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "SQLite upgrade failed."); process.exitCode = 1; }
}
