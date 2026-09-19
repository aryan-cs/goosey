import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CustodyEncryptionConfigurationError,
  CustodyKeyDecryptionError,
  generateSolanaSecretKey,
  openCustodySecretKey,
  resolveCustodyEncryptionConfiguration,
  sealCustodySecretKey,
} from "@/lib/solana/custody-crypto";
import {
  CustodyIdentityAccessError,
  CustodyIdentityMissingError,
  ensureAppManagedSolanaIdentity,
  loadAppManagedSolanaSigner,
} from "@/lib/solana/custody-service";

const PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const GENESIS = "11111111111111111111111111111111";

function environment(key = randomBytes(32).toString("base64url")) {
  return {
    NODE_ENV: "test",
    GOOSEY_SOLANA_CLUSTER: "localnet",
    GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:20999",
    GOOSEY_SOLANA_PROGRAM_ID: PROGRAM,
    GOOSEY_SOLANA_GENESIS_HASH: GENESIS,
    GOOSEY_SOLANA_CUSTODY_ENCRYPTION_KEY: key,
    GOOSEY_SOLANA_CUSTODY_KEY_ID: "test-key-2026-09",
  };
}

describe("custody key envelope", () => {
  it("requires a distinct explicit 256-bit server secret and key id", () => {
    expect(() => resolveCustodyEncryptionConfiguration({})).toThrow(CustodyEncryptionConfigurationError);
    expect(() => resolveCustodyEncryptionConfiguration({
      GOOSEY_SOLANA_CUSTODY_ENCRYPTION_KEY: randomBytes(31).toString("base64url"),
      GOOSEY_SOLANA_CUSTODY_KEY_ID: "active",
    })).toThrow(CustodyEncryptionConfigurationError);
    expect(() => resolveCustodyEncryptionConfiguration({
      GOOSEY_SOLANA_CUSTODY_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
      GOOSEY_SOLANA_CUSTODY_KEY_ID: "unsafe id",
    })).toThrow(CustodyEncryptionConfigurationError);
  });

  it("authenticates the user, network, address, version, and key id", () => {
    const env = environment();
    const configuration = resolveCustodyEncryptionConfiguration(env);
    const generated = generateSolanaSecretKey();
    const context = {
      userId: "user-one",
      chainId: "solana:localnet" as const,
      genesisHash: GENESIS,
      walletAddress: generated.walletAddress,
    };
    try {
      const sealed = sealCustodySecretKey(generated.secretKey, context, configuration);
      expect(sealed.encryptedSecretKey).not.toContain(generated.secretKey.toString("base64url"));
      const opened = openCustodySecretKey(sealed, context, configuration);
      expect(opened).toEqual(generated.secretKey);
      opened.fill(0);
      expect(() => openCustodySecretKey(sealed, { ...context, userId: "user-two" }, configuration))
        .toThrow(CustodyKeyDecryptionError);
      const replacement = sealed.encryptedSecretKey[0] === "A" ? "B" : "A";
      expect(() => openCustodySecretKey({ ...sealed,
        encryptedSecretKey: `${replacement}${sealed.encryptedSecretKey.slice(1)}` }, context, configuration))
        .toThrow(CustodyKeyDecryptionError);
    } finally {
      generated.secretKey.fill(0);
      configuration.key.fill(0);
    }
  });
});

describe("app-managed Solana custody identity service", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-custody-"));
  const databasePath = join(directory, "custody.db");
  const databaseUrl = `file:${databasePath}`;
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  const env = environment();
  let sequence = 0;

  async function user(status = "ACTIVE") {
    sequence += 1;
    return database.user.create({
      data: {
        email: `custody-${sequence}@example.com`,
        username: `custody_${sequence}`,
        displayName: `Custody ${sequence}`,
        passwordHash: "not-used-by-this-service",
        emailVerifiedAt: new Date(),
        status,
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const schemaSql = execFileSync(
      join(process.cwd(), "node_modules/.bin/prisma"),
      ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
        stdio: "pipe",
        timeout: 20_000,
        encoding: "utf8",
      },
    );
    execFileSync("sqlite3", [databasePath], { input: schemaSql, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 });
    await database.$connect();
  }, 30_000);

  afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates exactly one identity and returns only a public DTO", async () => {
    const account = await user();
    const first = await ensureAppManagedSolanaIdentity(account.id, env, database);
    const second = await ensureAppManagedSolanaIdentity(account.id, env, database);
    expect(second).toEqual(first);
    expect(Object.keys(first).sort()).toEqual([
      "chainId", "createdAt", "genesisHash", "id", "userId", "walletAddress",
    ]);
    expect(JSON.stringify(first)).not.toContain("encryptedSecretKey");
    expect(await database.solanaCustodyIdentity.count({ where: { userId: account.id } })).toBe(1);

    const stored = await database.solanaCustodyIdentity.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.encryptionAlgorithm).toBe("AES-256-GCM");
    expect(stored.keyId).toBe(env.GOOSEY_SOLANA_CUSTODY_KEY_ID);
    expect(stored.encryptedSecretKey).toHaveLength(86);
    expect(stored.encryptionNonce).toHaveLength(16);
    expect(stored.encryptionAuthTag).toHaveLength(22);
    expect(stored.encryptedSecretKey).not.toContain(first.walletAddress);

    const signer = await loadAppManagedSolanaSigner(account.id, env, database);
    expect(signer.address).toBe(first.walletAddress);
  });

  it("fails closed for ineligible users, absent identities, and altered ciphertext", async () => {
    const inactive = await user("SUSPENDED");
    await expect(ensureAppManagedSolanaIdentity(inactive.id, env, database)).rejects.toThrow(CustodyIdentityAccessError);
    expect(await database.solanaCustodyIdentity.count({ where: { userId: inactive.id } })).toBe(0);

    const absent = await user();
    await expect(loadAppManagedSolanaSigner(absent.id, env, database)).rejects.toThrow(CustodyIdentityMissingError);

    const account = await user();
    const identity = await ensureAppManagedSolanaIdentity(account.id, env, database);
    const stored = await database.solanaCustodyIdentity.findUniqueOrThrow({ where: { id: identity.id } });
    const replacement = stored.encryptedSecretKey.endsWith("A") ? "B" : "A";
    await database.solanaCustodyIdentity.update({
      where: { id: identity.id },
      data: { encryptedSecretKey: `${stored.encryptedSecretKey.slice(0, -1)}${replacement}` },
    });
    await expect(loadAppManagedSolanaSigner(account.id, env, database)).rejects.toThrow(CustodyKeyDecryptionError);
  });

  it("does not accept another deployment key or silently create a replacement identity", async () => {
    const account = await user();
    const identity = await ensureAppManagedSolanaIdentity(account.id, env, database);
    const otherEnvironment = environment();
    await expect(loadAppManagedSolanaSigner(account.id, otherEnvironment, database)).rejects.toThrow(CustodyKeyDecryptionError);
    expect((await database.solanaCustodyIdentity.findUniqueOrThrow({ where: { id: identity.id } })).walletAddress)
      .toBe(identity.walletAddress);
  });
});
