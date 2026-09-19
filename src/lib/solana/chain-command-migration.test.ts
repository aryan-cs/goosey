import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sqliteMigration = "prisma/sqlite-upgrades/20260920000000_chain_commands.sql";
const postgresMigration = "prisma/postgresql/migrations/20260920000000_chain_commands/migration.sql";
const directory = mkdtempSync(join(tmpdir(), "goosey-chain-command-migration-"));
const database = join(directory, "commands.db");

function sqlite(sql: string): string {
  return execFileSync("sqlite3", [database], { input: `PRAGMA foreign_keys=ON;\n${sql}`, encoding: "utf8" });
}

function commandInsert(id = "command_12345678") {
  return `INSERT INTO "ChainCommand" (
    "id", "cluster", "genesisHash", "programAddress", "scope", "scopeId", "actorId", "operation",
    "idempotencyKey", "requestHash", "requestJson", "updatedAt"
  ) VALUES (
    '${id}', 'localnet', '${"1".repeat(32)}', '${"2".repeat(32)}', 'USER', 'user_12345678',
    'user_12345678', 'ENROLLMENT', 'provisioning:v1:enrollment', '${"a".repeat(64)}', '{}', CURRENT_TIMESTAMP
  );`;
}

describe("durable ChainCommand migrations", () => {
  beforeAll(() => sqlite(readFileSync(sqliteMigration, "utf8")));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it("accepts a bounded command but rejects unsupported deployments", () => {
    expect(() => sqlite(commandInsert())).not.toThrow();
    expect(() => sqlite(commandInsert("mainnet_command").replace("'localnet'", "'mainnet-beta'"))).toThrow();
  });

  it("enforces immutable identity and exactly-one revision CAS updates", () => {
    expect(() => sqlite(`UPDATE "ChainCommand" SET "requestHash"='${"b".repeat(64)}', "revision"=1 WHERE "id"='command_12345678';`))
      .toThrow(/identity is immutable/);
    expect(() => sqlite("UPDATE \"ChainCommand\" SET \"status\"='PREPARED' WHERE \"id\"='command_12345678';"))
      .toThrow(/revision must increment/);
    expect(() => sqlite(`UPDATE "ChainCommand" SET "status"='PREPARED', "revision"=1,
      "leaseOwner"='worker_12345678', "leaseTokenHash"='${"d".repeat(64)}', "leaseEpoch"=1,
      "leaseExpiresAt"='2099-01-01T00:00:00.000Z', "attemptCount"=1 WHERE "id"='command_12345678';`))
      .not.toThrow();
  });

  it("keeps exact signed-wire rows append-only and strictly bounded", () => {
    const insert = `INSERT INTO "ChainCommandSignedWire" (
      "id", "commandId", "sequence", "leaseEpoch", "commandRevision", "wireVersion", "signedWireBase64",
      "signedWireByteLength", "signedWireSha256", "transactionSignature", "recentBlockhash",
      "lastValidBlockHeight", "durableNonceAddress", "feePayerAddress", "signerAddressesJson"
    ) VALUES (
      'wire_12345678', 'command_12345678', 0, 1, 1, 'legacy', 'AAAA', 3, '${"c".repeat(64)}',
      '${"3".repeat(88)}', '${"4".repeat(32)}', 100, NULL, '${"5".repeat(32)}', '["${"5".repeat(32)}"]'
    );`;
    expect(() => sqlite(insert)).not.toThrow();
    expect(() => sqlite("UPDATE \"ChainCommandSignedWire\" SET \"sequence\"=1 WHERE \"id\"='wire_12345678';"))
      .toThrow(/append-only/);
    expect(() => sqlite("DELETE FROM \"ChainCommandSignedWire\" WHERE \"id\"='wire_12345678';"))
      .toThrow(/append-only/);
    expect(() => sqlite(insert.replace("'wire_12345678'", "'wire_bad_lifetime'").replace("100, NULL", "NULL, NULL")))
      .toThrow();
  });

  it("gives PostgreSQL equivalent deployment, bounds, immutability, and append-only guards", () => {
    const sql = readFileSync(postgresMigration, "utf8");
    expect(sql).toMatch(/ChainCommand_cluster_check/);
    expect(sql).toMatch(/ChainCommand_request_check/);
    expect(sql).toMatch(/ChainCommand_guard_update/);
    expect(sql).toMatch(/revision must increment exactly once/);
    expect(sql).toMatch(/ChainCommandSignedWire_deny_mutation/);
    expect(sql).toMatch(/signedWireByteLength" BETWEEN 1 AND 1232/);
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i);
  });
});
