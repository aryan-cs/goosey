import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteBackup } from "./sqlite-backup";

const execute = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
const seed = `
  CREATE TABLE balances (id INTEGER PRIMARY KEY, amount TEXT NOT NULL, note TEXT);
  INSERT INTO balances VALUES (1, '9223372036854775807', 'Goose''s feathers 🪶');
  INSERT INTO balances VALUES (2, '-9007199254740993', 'literal text');
  CREATE INDEX balances_amount ON balances(amount);
  PRAGMA user_version = 7;
`;

async function sql(path: string, statement: string) {
  const { stdout } = await execute("sqlite3", ["-batch", "-bail", path, statement], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function fixture(name = "source.db") {
  const directory = await mkdtemp(join(tmpdir(), "goosey-backup-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, name);
  await sql(source, seed);
  return { directory, source, destination: join(directory, "backup.db") };
}

async function absent(path: string) {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function assertMetadata(result: { path: string; bytes: number; sha256: string }, destination: string) {
  const bytes = await readFile(destination);
  expect(result.path).toBe(destination);
  expect(result.bytes).toBe(bytes.length);
  expect(result.bytes).toBeGreaterThan(0);
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
}

// stdin stays open so SQLite cannot checkpoint the WAL on connection shutdown.
async function holdWalConnection(source: string) {
  const child = spawn("sqlite3", ["-batch", "-bail", source], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdin.on("error", () => { /* Process exit is handled below. */ });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  cleanup.push(async () => {
    child.stdin.end(".quit\n");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1_000);
    try { await closed; } finally { clearTimeout(kill); }
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error(`SQLite WAL setup timed out: ${stderr}`)), 5_000);
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error(`SQLite exited before WAL setup: ${stderr}`));
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("WAL_READY\n")) finish();
    };
    function finish(error?: Error) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error); else resolve();
    }
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    child.stdin.write(`PRAGMA journal_mode=WAL;\nPRAGMA wal_autocheckpoint=0;\nBEGIN;\nINSERT INTO balances VALUES (3, '18446744073709551615', 'committed in WAL');\nCOMMIT;\n.print WAL_READY\n`);
  });
  return child;
}

afterEach(async () => {
  // Close live connections before removing their temporary directories.
  for (const operation of cleanup.splice(0).reverse()) await operation();
});

describe("createSqliteBackup (real sqlite3 files)", () => {
  it("restores schema and exact bigint text values, reports file metadata, and leaves source bytes unchanged", async () => {
    const { source, destination, directory } = await fixture();
    const original = await readFile(source);
    const result = await createSqliteBackup(source, destination);
    await assertMetadata(result, destination);
    expect(await readFile(source)).toEqual(original);

    const restored = join(directory, "restored.db");
    await copyFile(destination, restored);
    expect(await sql(restored, "PRAGMA integrity_check;")).toBe("ok");
    expect(await sql(restored, "PRAGMA user_version;")).toBe("7");
    expect(await sql(restored, "SELECT name FROM sqlite_master WHERE type='index';")).toBe("balances_amount");
    expect(await sql(restored, "SELECT id, amount, typeof(amount), note FROM balances ORDER BY id;")).toBe(
      "1|9223372036854775807|text|Goose's feathers 🪶\n2|-9007199254740993|text|literal text",
    );
    await sql(restored, "INSERT INTO balances VALUES (4, '42', 'restored writable');");
    expect(await sql(source, "SELECT count(*) FROM balances;")).toBe("2");
    expect(await readFile(source)).toEqual(original);
  });

  it("refuses an existing destination without overwriting it or changing the source", async () => {
    const { source, destination } = await fixture();
    const original = await readFile(source);
    await writeFile(destination, "existing backup must survive");
    await expect(createSqliteBackup(source, destination)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("existing backup must survive");
    expect(await readFile(source)).toEqual(original);
  });

  it("refuses source equal to destination without changing the database", async () => {
    const { source } = await fixture();
    const original = await readFile(source);
    await expect(createSqliteBackup(source, source)).rejects.toThrow();
    expect(await readFile(source)).toEqual(original);
  });

  it.each(["source", "destination"] as const)("refuses a relative %s path without changing either file", async (relativeField) => {
    const { source, destination } = await fixture();
    const original = await readFile(source);
    await expect(createSqliteBackup(
      relativeField === "source" ? relative(process.cwd(), source) : source,
      relativeField === "destination" ? relative(process.cwd(), destination) : destination,
    )).rejects.toThrow(/absolute path/i);
    expect(await readFile(source)).toEqual(original);
    await absent(destination);
  });

  it("refuses a dangling destination symlink, preserving the link and leaving its target absent", async () => {
    const { source, destination, directory } = await fixture();
    const original = await readFile(source);
    const target = join(directory, "missing-link-target.db");
    await symlink(target, destination);
    const before = await lstat(destination);
    await expect(createSqliteBackup(source, destination)).rejects.toThrow();
    const after = await lstat(destination);
    expect(after.isSymbolicLink()).toBe(true);
    expect(after.ino).toBe(before.ino);
    expect(await readlink(destination)).toBe(target);
    await absent(target);
    expect(await readFile(source)).toEqual(original);
  });

  it("refuses a missing source and creates neither source nor destination", async () => {
    const { directory, destination } = await fixture();
    const missing = join(directory, "missing.db");
    await expect(createSqliteBackup(missing, destination)).rejects.toThrow();
    await absent(missing);
    await absent(destination);
  });

  it("refuses a corrupt source without publishing a backup or modifying the source", async () => {
    const { source, destination } = await fixture();
    await writeFile(source, "This is not a SQLite database.\n");
    const original = await readFile(source);
    await expect(createSqliteBackup(source, destination)).rejects.toThrow();
    await absent(destination);
    expect(await readFile(source)).toEqual(original);
  });

  it("makes the backup owner-only even when the source is readable by others", async () => {
    const { source, destination } = await fixture();
    await chmod(source, 0o644);
    await createSqliteBackup(source, destination);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await stat(source)).mode & 0o777).toBe(0o644);
  });

  it("handles spaces and both quote characters in source and destination paths", async () => {
    const { source, directory } = await fixture(`goose's "source" file.db`);
    const destination = join(directory, `goose's "backup" file.db`);
    const result = await createSqliteBackup(source, destination);
    await assertMetadata(result, destination);
    expect(await sql(destination, "SELECT amount FROM balances WHERE id=1;")).toBe("9223372036854775807");
  });

  it("includes committed WAL data while the source connection is still alive, without changing source data", async () => {
    const { source, destination, directory } = await fixture();
    const child = await holdWalConnection(source);
    expect(child.exitCode).toBeNull();
    const mainBefore = await readFile(source);
    const walBefore = await readFile(`${source}-wal`);
    expect(walBefore.length).toBeGreaterThan(0);
    const mainOnly = join(directory, "without-wal.db");
    await copyFile(source, mainOnly);
    expect(await sql(mainOnly, "SELECT count(*) FROM balances;")).toBe("2");
    const result = await createSqliteBackup(source, destination);
    expect(child.exitCode).toBeNull();
    await assertMetadata(result, destination);
    expect(await sql(destination, "PRAGMA integrity_check; SELECT amount FROM balances WHERE id=3;")).toBe("ok\n18446744073709551615");
    expect(await readFile(source)).toEqual(mainBefore);
    expect(await readFile(`${source}-wal`)).toEqual(walBefore);
    expect(await sql(source, "SELECT count(*) FROM balances;")).toBe("3");
  });

  it("publishes exactly one complete backup when calls race for the same destination", async () => {
    const { source, destination } = await fixture();
    const original = await readFile(source);
    const results = await Promise.allSettled([
      createSqliteBackup(source, destination),
      createSqliteBackup(source, destination),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No backup won the destination race");
    await assertMetadata(winner.value, destination);
    expect(await sql(destination, "PRAGMA integrity_check; SELECT count(*) FROM balances;")).toBe("ok\n2");
    expect(await readFile(source)).toEqual(original);
  });
}, 15_000);
