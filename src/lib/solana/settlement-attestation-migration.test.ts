import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = mkdtempSync(join(tmpdir(), "goosey-settlement-attestation-migration-"));
const database = join(directory, "attestations.db");

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [database], { input: `PRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8" });
}

describe("database settlement attestation migrations", () => {
  beforeAll(() => {
    sqlite('CREATE TABLE "MarketSettlementRun" ("id" TEXT NOT NULL PRIMARY KEY);');
    sqlite(readFileSync("prisma/sqlite-upgrades/20260920000000_chain_commands.sql", "utf8"));
    sqlite(readFileSync("prisma/sqlite-upgrades/20260920002000_database_settlement_attestations.sql", "utf8"));
    sqlite(`INSERT INTO "MarketSettlementRun" ("id") VALUES ('run_12345678');`);
    sqlite(`INSERT INTO "ChainCommand" (
      "id", "cluster", "genesisHash", "programAddress", "scope", "scopeId", "actorId", "operation",
      "idempotencyKey", "requestHash", "requestJson", "updatedAt"
    ) VALUES (
      'command_12345678', 'devnet', '${"1".repeat(32)}', '${"2".repeat(32)}', 'MARKET', 'market_12345678',
      'system_12345678', 'ATTEST_DATABASE_SETTLEMENT', 'settlement:v1', '${"a".repeat(64)}', '{}', CURRENT_TIMESTAMP
    );`);
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("accepts one pending receipt and enforces immutable identity", () => {
    const insert = `INSERT INTO "MarketSettlementAttestation" (
      "id", "settlementRunId", "commandId", "digest", "marketDigest", "updatedAt"
    ) VALUES (
      'attestation_12345678', 'run_12345678', 'command_12345678', '${"b".repeat(64)}', '${"c".repeat(64)}', CURRENT_TIMESTAMP
    );`;
    expect(() => sqlite(insert)).not.toThrow();
    expect(() => sqlite(`UPDATE "MarketSettlementAttestation" SET "digest"='${"d".repeat(64)}' WHERE "id"='attestation_12345678';`))
      .toThrow(/identity is immutable/);
  });

  it("requires finalized receipt fields together and freezes them after finalization", () => {
    expect(() => sqlite(`UPDATE "MarketSettlementAttestation" SET "signature"='sig' WHERE "id"='attestation_12345678';`))
      .toThrow();
    expect(() => sqlite(`UPDATE "MarketSettlementAttestation" SET "signature"='sig', "slot"=42,
      "attestedAt"='2026-09-19T12:00:00.000Z', "updatedAt"=CURRENT_TIMESTAMP WHERE "id"='attestation_12345678';`))
      .not.toThrow();
    expect(() => sqlite(`UPDATE "MarketSettlementAttestation" SET "slot"=43 WHERE "id"='attestation_12345678';`))
      .toThrow(/finalized receipt is immutable/);
  });

  it("defines equivalent PostgreSQL checks and immutability guards", () => {
    const sql = readFileSync("prisma/postgresql/migrations/20260920002000_database_settlement_attestations/migration.sql", "utf8");
    expect(sql).toMatch(/receipt_check/);
    expect(sql).toMatch(/identity is immutable/);
    expect(sql).toMatch(/finalized receipt is immutable/);
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i);
  });
});
