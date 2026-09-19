import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const sqliteMigration = "prisma/sqlite-upgrades/20260919234000_solana_coverage_rotations.sql";
const postgresMigration = "prisma/postgresql/migrations/20260919234000_solana_coverage_rotations/migration.sql";
const normalize = (source: string) => source.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

async function generatedRotationDdl(schema: string) {
  const { stdout } = await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff",
    "--from-empty", "--to-schema-datamodel", schema, "--script"], { maxBuffer: 8 * 1024 * 1024 });
  const statements = stdout.split(";").filter(statement =>
    /(?:CREATE TABLE "SolanaCoverageRotation"|CREATE (?:UNIQUE )?INDEX "SolanaRotation_)/.test(statement));
  return normalize(`${statements.join(";")};`);
}

describe("append-only coverage rotation migrations", () => {
  it.each([
    ["SQLite", "prisma/schema.prisma", sqliteMigration, "CREATE TRIGGER"],
    ["PostgreSQL", "prisma/postgresql/schema.prisma", postgresMigration, "CREATE FUNCTION"],
  ])("matches generated %s table/index DDL and only adds mutation-denial objects", async (_name, schema, path, triggerStart) => {
    const source = await readFile(path, "utf8");
    expect(normalize(source.slice(0, source.indexOf(triggerStart)))).toBe(await generatedRotationDdl(schema));
    expect(source).toMatch(/SolanaCoverageRotation_no_(?:update|update_or_delete)/);
    expect(source).toMatch(/SolanaCoverageRotation_no_delete|BEFORE UPDATE OR DELETE/);
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE FROM)\s+"SolanaIngestionCursor"/i);
    expect(source).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i);
  });
});
