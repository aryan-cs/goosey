import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { upgradeSolanaSqlite } from "../solana-upgrade-sqlite";
const execute = promisify(execFile);
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function sql(source: string, statement: string) {
  return (await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", source, statement], { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "goosey-upgrade-test-")); directories.push(directory);
  const source = path.join(directory, "source.db"), backup = path.join(directory, "backup.db");
  await sql(source, `PRAGMA journal_mode=WAL; CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "balance" BIGINT NOT NULL);
    INSERT INTO "User" VALUES ('actual-test-user',9223372036854775807);`);
  return { source, backup, directory };
}
const migration = (name: string) => readFile(path.resolve("prisma/sqlite-upgrades", name + ".sql"), "utf8");
const names = ["20260919210000_solana_wallet_links", "20260919220000_solana_event_journal",
  "20260919230000_solana_ingestion_visits", "20260919234000_solana_coverage_rotations",
  "20260919235000_app_managed_solana_custody", "20260920000000_chain_commands",
  "20260920001000_registration_devices", "20260920002000_solana_provisioning_checkpoints"];
describe("additive Solana SQLite upgrade (real disposable databases)", () => {
  it("applies every reviewed Solana migration atomically, preserves exact cash, backs up old schema and rechecks completed schemas", async () => {
    const f = await fixture();
    expect((await upgradeSolanaSqlite(f.source, f.backup)).applied).toEqual(names);
    expect(await sql(f.source, 'SELECT quote(balance) FROM "User"')).toBe("9223372036854775807");
    expect(await sql(f.backup, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'Solana%' ")).toBe("0");
    expect(await sql(f.source, "PRAGMA integrity_check; PRAGMA foreign_key_check;")).toBe("ok");
    expect((await upgradeSolanaSqlite(f.source, path.join(f.directory, "second.db"))).applied).toEqual([]);
  });
  it("applies only pending complete migration groups", async () => {
    const f = await fixture(); await sql(f.source, await migration(names[0]));
    expect((await upgradeSolanaSqlite(f.source, f.backup)).applied).toEqual(names.slice(1));
  });
  it.each([
    'DROP INDEX "SolanaWalletLink_userId_idx";',
    'DROP INDEX "SolanaWalletLink_userId_idx"; CREATE INDEX "SolanaWalletLink_userId_idx" ON "SolanaWalletLink"("walletAddress");',
    'CREATE TRIGGER unexpected AFTER INSERT ON "SolanaWalletLink" BEGIN UPDATE "User" SET balance=0; END;',
    'ALTER TABLE "SolanaWalletLink" ADD COLUMN unexpected TEXT;',
  ])("rejects incompatible existing schema without applying pending tables: %s", async change => {
    const f = await fixture(); await sql(f.source, (await migration(names[0])) + change);
    const before = await sql(f.source, "SELECT sql FROM sqlite_master ORDER BY name");
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow();
    expect(await sql(f.source, "SELECT sql FROM sqlite_master ORDER BY name")).toBe(before);
    expect(await sql(f.source, 'SELECT quote(balance) FROM "User"')).toBe("9223372036854775807");
  });
  it("refuses FK-invalid state and rolls back pending DDL", async () => {
    const f = await fixture(); await sql(f.source, `CREATE TABLE child (id TEXT REFERENCES "User"(id)); INSERT INTO child VALUES ('absent');`);
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow();
    expect(await sql(f.source, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'Solana%' ")).toBe("0");
  });
  it("rolls back earlier migrations when a later DDL statement fails", async () => {
    const f = await fixture();
    // SQLite names are case-insensitive: this unexpected spelling is not an
    // accepted schema, and the journal CREATE fails after wallet DDL has run.
    await sql(f.source, "CREATE TABLE solanaprogramevent(unexpected TEXT);");
    const before = await sql(f.source, "SELECT sql FROM sqlite_master ORDER BY name");
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow();
    expect(await sql(f.source, "SELECT sql FROM sqlite_master ORDER BY name")).toBe(before);
    expect(await sql(f.source, 'SELECT quote(balance) FROM "User"')).toBe("9223372036854775807");
  });
  it("rejects wrong defaults and foreign-key semantics even when all objects exist", async () => {
    const f = await fixture();
    await sql(f.source, (await migration(names[0])).replace("DEFAULT 'LINK_WALLET'", "DEFAULT 'WRONG'").replaceAll("ON DELETE CASCADE", "ON DELETE RESTRICT"));
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow(/schema differs/);
  });
  it("refuses non-WAL without changing source", async () => {
    const f = await fixture(); await sql(f.source, "PRAGMA journal_mode=DELETE;");
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow(/WAL/);
    expect(await sql(f.source, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'Solana%' ")).toBe("0");
  });
  it("refuses existing backup without changing source", async () => {
    const f = await fixture(); await sql(f.backup, "CREATE TABLE retained(x);");
    await expect(upgradeSolanaSqlite(f.source, f.backup)).rejects.toThrow(/exists/);
    expect(await sql(f.source, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'Solana%' ")).toBe("0");
  });
  it("supports an already-open WAL writer connection before and after upgrade", async () => {
    const f = await fixture();
    const child = spawn("sqlite3", ["-batch", "-bail", "-init", "/dev/null", f.source]);
    child.stdin.on("error", () => {}); let output = "";
    child.stdout.on("data", b => { output += String(b); }); child.stderr.resume();
    const done = new Promise(resolve => child.on("close", resolve));
    const wait = async (text: string) => { const deadline = Date.now() + 5000; while (!output.includes(text)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error("Writer did not complete");
      await new Promise(resolve => setTimeout(resolve, 10));
    } };
    try {
      child.stdin.write("PRAGMA busy_timeout=5000; INSERT INTO User VALUES ('before',10); SELECT 'before-ready';\n"); await wait("before-ready");
      child.stdin.write("BEGIN IMMEDIATE; INSERT INTO User VALUES ('uncommitted',30); SELECT 'writer-held';\n"); await wait("writer-held");
      await expect(upgradeSolanaSqlite(f.source, path.join(f.directory, "contended-backup.db"))).rejects.toThrow(/contention/);
      expect(await sql(f.source, "SELECT count(*) FROM sqlite_master WHERE name LIKE 'Solana%' ")).toBe("0");
      child.stdin.write("ROLLBACK; SELECT 'writer-released';\n"); await wait("writer-released");
      child.stdin.write("BEGIN; SELECT 'reader-before:' || count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'Solana%';\n"); await wait("reader-before:0");
      await upgradeSolanaSqlite(f.source, f.backup);
      child.stdin.write("SELECT 'reader-still:' || count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'Solana%'; COMMIT; SELECT 'reader-after:' || count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'Solana%'; INSERT INTO User VALUES ('after',20); SELECT 'after-ready';\n"); await wait("after-ready");
      expect(output).toContain("reader-still:0"); expect(output).toContain("reader-after:9");
      expect(await sql(f.source, "SELECT count(*) FROM User")).toBe("3");
      expect(await sql(f.backup, "SELECT count(*) FROM User")).toBe("2");
    } finally { child.stdin.end(); const kill = setTimeout(() => child.kill("SIGKILL"), 1000); await done; clearTimeout(kill); }
  }, 20_000);
});
