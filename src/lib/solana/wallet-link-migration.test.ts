import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cleanup: string[] = [];
const upgradePath = join(
  process.cwd(),
  "prisma/sqlite-upgrades/20260919210000_solana_wallet_links.sql",
);

const legacySchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE "User" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "email" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "emailVerifiedAt" DATETIME,
  "role" TEXT NOT NULL DEFAULT 'USER',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "bio" TEXT NOT NULL DEFAULT '',
  "profilePublic" BOOLEAN NOT NULL DEFAULT false,
  "leaderboardVisible" BOOLEAN NOT NULL DEFAULT false,
  "notificationPreferences" TEXT NOT NULL DEFAULT '{}',
  "balanceMilli" BIGINT NOT NULL DEFAULT 0,
  "realizedPnlMilli" BIGINT NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "lastActiveAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE TABLE "Session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userAgent" TEXT,
  "ipHash" TEXT,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
INSERT INTO "User" ("id", "email", "username", "displayName", "passwordHash", "emailVerifiedAt", "balanceMilli", "updatedAt")
VALUES
  ('legacy-user', 'legacy@example.com', 'legacy_user', 'Legacy User', 'legacy-password-hash', '2026-09-19T12:00:00.000Z', 123456, '2026-09-19T12:00:00.000Z'),
  ('other-user', 'other@example.com', 'other_user', 'Other User', 'other-password-hash', '2026-09-19T12:00:00.000Z', 789, '2026-09-19T12:00:00.000Z');
INSERT INTO "Session" ("id", "tokenHash", "userId", "expiresAt", "userAgent")
VALUES ('legacy-session', 'legacy-token-hash', 'legacy-user', '2026-09-20T12:00:00.000Z', 'legacy-browser');
`;

const challengeInsert = `
INSERT INTO "SolanaWalletLinkChallenge" (
  "id", "userId", "sessionId", "origin", "domain", "uri", "chainId", "genesisHash",
  "walletAddress", "nonceHash", "messageHash", "issuedAt", "expiresAt", "consumedAt"
) VALUES (
  'challenge-1', 'legacy-user', 'legacy-session', 'http://127.0.0.1:8080', '127.0.0.1:8080',
  'http://127.0.0.1:8080', 'solana:localnet', '11111111111111111111111111111111',
  '11111111111111111111111111111111', 'nonce-hash-1', 'message-hash-1',
  '2026-09-19T12:00:00.000Z', '2026-09-19T12:05:00.000Z', '2026-09-19T12:01:00.000Z'
);
`;

async function sqlite(database: string, statement: string): Promise<string> {
  const { stdout } = await execute(
    "sqlite3",
    ["-batch", "-bail", "-init", process.platform === "win32" ? "NUL" : "/dev/null", database, statement],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

async function applyUpgrade(database: string, source: string): Promise<void> {
  await execute(
    "sqlite3",
    [
      "-batch",
      "-bail",
      "-init",
      process.platform === "win32" ? "NUL" : "/dev/null",
      database,
      `PRAGMA foreign_keys = ON;\nBEGIN IMMEDIATE;\n${source}\nCOMMIT;\n`,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
}

afterEach(async () => {
  for (const directory of cleanup.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SQLite Solana wallet-link additive upgrade", () => {
  it("applies the checked-in SQL to populated legacy tables without losing rows and enforces its constraints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goosey-wallet-link-upgrade-"));
    cleanup.push(directory);
    const database = join(directory, "legacy.db");
    const upgrade = await readFile(upgradePath, "utf8");

    await sqlite(database, legacySchema);
    await applyUpgrade(database, upgrade);

    expect(await sqlite(database, `
      SELECT u.id, u.balanceMilli, s.id, s.userAgent
      FROM "User" u JOIN "Session" s ON s.userId = u.id
      WHERE u.id = 'legacy-user';
    `)).toBe("legacy-user|123456|legacy-session|legacy-browser");
    expect(await sqlite(database, `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('SolanaWalletLinkChallenge', 'SolanaWalletLink')
      ORDER BY name;
    `)).toBe("SolanaWalletLink\nSolanaWalletLinkChallenge");

    await sqlite(database, challengeInsert);
    await sqlite(database, `
      INSERT INTO "SolanaWalletLink" ("id", "userId", "chainId", "genesisHash", "walletAddress", "verifiedAt", "updatedAt")
      VALUES ('link-1', 'legacy-user', 'solana:localnet', '11111111111111111111111111111111',
        '11111111111111111111111111111111', '2026-09-19T12:01:00.000Z', '2026-09-19T12:01:00.000Z');
    `);

    await expect(sqlite(database, `PRAGMA foreign_keys = ON;
      INSERT INTO "SolanaWalletLink" ("id", "userId", "chainId", "genesisHash", "walletAddress", "verifiedAt", "updatedAt")
      VALUES ('missing-user-link', 'missing-user', 'solana:localnet', 'genesis-2', 'wallet-2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(sqlite(database, `PRAGMA foreign_keys = ON;
      INSERT INTO "Session" ("id", "tokenHash", "userId", "expiresAt")
      VALUES ('orphan-session', 'orphan-token', 'missing-user', '2026-09-20T12:00:00.000Z');
    `)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(sqlite(database, `PRAGMA foreign_keys = ON;
      INSERT INTO "SolanaWalletLinkChallenge" (
        "id", "userId", "sessionId", "origin", "domain", "uri", "chainId", "genesisHash",
        "walletAddress", "nonceHash", "messageHash", "issuedAt", "expiresAt"
      ) VALUES (
        'orphan-challenge', 'missing-user', 'missing-session', 'http://127.0.0.1:8080',
        '127.0.0.1:8080', 'http://127.0.0.1:8080', 'solana:localnet', 'genesis-2',
        'wallet-2', 'nonce-hash-2', 'message-hash-2', CURRENT_TIMESTAMP, '2026-09-20T12:00:00.000Z'
      );
    `)).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    await expect(sqlite(database, `
      INSERT INTO "SolanaWalletLink" ("id", "userId", "chainId", "genesisHash", "walletAddress", "verifiedAt", "updatedAt")
      VALUES ('same-wallet-link', 'other-user', 'solana:localnet', '11111111111111111111111111111111',
        '11111111111111111111111111111111', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(sqlite(database, `
      INSERT INTO "SolanaWalletLink" ("id", "userId", "chainId", "genesisHash", "walletAddress", "verifiedAt", "updatedAt")
      VALUES ('same-user-link', 'legacy-user', 'solana:localnet', '11111111111111111111111111111111',
        '22222222222222222222222222222222', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    `)).rejects.toThrow(/UNIQUE constraint failed/i);
    await expect(sqlite(database, challengeInsert.replace("'challenge-1'", "'challenge-2'")))
      .rejects.toThrow(/UNIQUE constraint failed/i);

    await sqlite(database, `PRAGMA foreign_keys = ON; DELETE FROM "Session" WHERE id = 'legacy-session';`);
    expect(await sqlite(database, `SELECT sessionId, consumedAt FROM "SolanaWalletLinkChallenge" WHERE id = 'challenge-1';`))
      .toBe("legacy-session|2026-09-19T12:01:00.000Z");
    expect(await sqlite(database, "PRAGMA foreign_key_check;")).toBe("");
    expect(await sqlite(database, "PRAGMA integrity_check;")).toBe("ok");

    await expect(applyUpgrade(database, upgrade)).rejects.toThrow(/already exists/i);
    expect(await sqlite(database, `SELECT COUNT(*) FROM "User"; SELECT COUNT(*) FROM "SolanaWalletLink";`))
      .toBe("2\n1");
  });
});
