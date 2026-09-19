import { describe, expect, it } from "vitest";
import { validatePostgresMigrationContract } from "../../scripts/check-postgres-migrations";

const validContract = () => ({
  lockSource: 'provider = "postgresql"\n',
  generatedBaseline: '-- CreateTable\nCREATE TABLE "User" ("id" TEXT NOT NULL);\n',
  migrationDirectories: ["00000000000000_baseline"],
  migrationSources: {
    "00000000000000_baseline": '-- CreateTable\nCREATE TABLE "User" ("id" TEXT NOT NULL);\n',
  } as Record<string, string>,
});

describe("PostgreSQL migration contract", () => {
  it("accepts a reproducible deployable baseline", () => {
    expect(validatePostgresMigrationContract(validContract())).toEqual([]);
  });

  it("rejects provider drift and a changed deployable baseline", () => {
    const contract = validContract();
    contract.lockSource = 'provider = "sqlite"\n';
    contract.migrationSources["00000000000000_baseline"] += "-- drift\n";
    expect(validatePostgresMigrationContract(contract)).toEqual([
      'migration_lock.toml must declare provider = "postgresql"; found "sqlite"',
      "The deployable PostgreSQL baseline migration differs from baseline.generated.sql",
    ]);
  });

  it("rejects missing, malformed, duplicate, empty, and SQLite migrations", () => {
    const contract = validContract();
    contract.migrationDirectories = [
      "00000000000000_baseline",
      "20260919010101_add_one",
      "20260919010101_add_two",
      "bad-name",
    ];
    contract.migrationSources["20260919010101_add_one"] = "PRAGMA foreign_keys = ON;\n";
    contract.migrationSources["20260919010101_add_two"] = "";
    expect(validatePostgresMigrationContract(contract).join("\n")).toMatch(/SQLite-only SQL/);
    expect(validatePostgresMigrationContract(contract).join("\n")).toMatch(/Duplicate PostgreSQL migration timestamp/);
    expect(validatePostgresMigrationContract(contract).join("\n")).toMatch(/Invalid PostgreSQL migration directory name/);
    expect(validatePostgresMigrationContract(contract).join("\n")).toMatch(/Missing or empty migration.sql/);
  });

  it("rejects destructive statements in an initial baseline", () => {
    const contract = validContract();
    contract.generatedBaseline = 'DROP SCHEMA public;\n';
    contract.migrationSources["00000000000000_baseline"] = contract.generatedBaseline;
    expect(validatePostgresMigrationContract(contract)).toContain(
      "The initial PostgreSQL baseline contains a destructive DROP statement",
    );
  });
});
