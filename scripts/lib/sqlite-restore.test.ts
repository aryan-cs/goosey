import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { verifySqliteRestore } from "./sqlite-restore";

const execute = promisify(execFile);
const directories: string[] = [];
async function sql(path: string, statement: string) {
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", path, statement], { timeout: 5_000, maxBuffer: 1024 * 1024 });
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "goosey-restore-test-"));
  directories.push(directory);
  const source = join(directory, "archive's.db");
  const restored = join(directory, "restored.db");
  await sql(source, `CREATE TABLE "balance's" (id INTEGER PRIMARY KEY AUTOINCREMENT, "cash\"\"value" INTEGER, note TEXT, data BLOB, optional REAL);
    INSERT INTO "balance's" VALUES (1, 9223372036854775807, 'secret text' || char(0) || 'tail', X'00FF1027', NULL);
    INSERT INTO "balance's" VALUES (2, -9007199254740993, '🪶', X'', 1.25);
    CREATE INDEX "quoted\"\"index" ON "balance's" (note);
    CREATE VIEW balances_view AS SELECT id FROM "balance's";`);
  await copyFile(source, restored);
  return { source, restored };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("read-only SQLite restore comparison", () => {
  it("matches a snapshot copy exactly, without modifying either database", async () => {
    const { source, restored } = await fixture();
    const before = await Promise.all([readFile(source), readFile(restored)]);
    const result = await verifySqliteRestore(source, restored);
    expect(result).toEqual({ status: "matched", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(await Promise.all([readFile(source), readFile(restored)])).toEqual(before);
  });

  it.each([
    ["altered exact bigint balance", `UPDATE "balance's" SET "cash\"\"value"=9223372036854775806 WHERE id=1;`],
    ["deleted row", `DELETE FROM "balance's" WHERE id=2;`],
    ["missing table", `DROP TABLE "balance's";`],
    ["changed text after embedded NUL", `UPDATE "balance's" SET note='secret text' || char(0) || 'different' WHERE id=1;`],
    ["changed blob", `UPDATE "balance's" SET data=X'00FF1028' WHERE id=1;`],
    ["changed autoincrement sequence", `UPDATE sqlite_sequence SET seq=99;`],
  ])("rejects %s", async (_label, change) => {
    const { source, restored } = await fixture();
    await sql(restored, change);
    await expect(verifySqliteRestore(source, restored)).rejects.toThrow(/mismatch/);
  });

  it("compares rows deterministically regardless of physical insertion order and ignores optimizer stats", async () => {
    const { source, restored } = await fixture();
    for (const path of [source, restored]) await sql(path, "CREATE TABLE unordered(value TEXT);");
    await sql(source, "INSERT INTO unordered VALUES ('z'), ('a'), ('a'); ANALYZE;");
    await sql(restored, "INSERT INTO unordered VALUES ('a'), ('z'), ('a');");
    await expect(verifySqliteRestore(source, restored)).resolves.toMatchObject({ status: "matched" });
  });

  it("CLI exits nonzero for an empty restored database, without printing table data", async () => {
    const { source, restored } = await fixture();
    await sql(restored, `DROP VIEW balances_view; DROP TABLE "balance's";`);
    await expect(execute(process.execPath, ["--import", "tsx", resolve("scripts/verify-sqlite-restore.ts"), "--source", source, "--restored", restored], {
      timeout: 10_000, maxBuffer: 1024 * 1024,
    })).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("mismatch") });
  });
}, 15_000);
