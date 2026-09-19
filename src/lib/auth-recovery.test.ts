import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildAccountActionUrl,
  confirmEmailVerificationWithDatabase,
  confirmPasswordResetWithDatabase,
  EMAIL_VERIFICATION_PURPOSE,
  InvalidAccountTokenError,
  isValidAccountToken,
  PASSWORD_RESET_PURPOSE,
  tokenDurationMinutes,
} from "./auth-recovery";
import {
  hashPassword,
  parseWelcomeGrantMilli,
  verifyPassword,
  WelcomeGrantConfigurationError,
} from "./auth";
import { EmailConfigurationError, smtpConfigFromEnvironment } from "./email";
import { randomToken, sha256 } from "./security";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("account recovery tokens", () => {
  it("accepts only canonical 256-bit bearer tokens", () => {
    const token = randomToken();
    expect(isValidAccountToken(token)).toBe(true);
    expect(isValidAccountToken(token.slice(1))).toBe(false);
    expect(isValidAccountToken(`${token.slice(0, -1)}!`)).toBe(false);
    expect(isValidAccountToken("A".repeat(43))).toBe(true);
  });

  it("builds a purpose-specific link without mutating unrelated query parameters", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EMAIL_VERIFICATION_URL", "http://localhost:8080/verify-email?source=email");
    const token = randomToken();
    const url = new URL(buildAccountActionUrl("EMAIL_VERIFICATION_URL", "/verify-email", token));
    expect(url.pathname).toBe("/verify-email");
    expect(url.searchParams.get("source")).toBe("email");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe(token);
  });

  it("requires HTTPS for action links in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PASSWORD_RESET_URL", "http://goosey.example/reset-password");
    expect(() => buildAccountActionUrl("PASSWORD_RESET_URL", "/reset-password", randomToken()))
      .toThrow(EmailConfigurationError);
  });

  it("bounds token lifetimes", () => {
    vi.stubEnv("PASSWORD_RESET_TTL_MINUTES", "30");
    expect(tokenDurationMinutes("PASSWORD_RESET_TTL_MINUTES", 20, 240)).toBe(30);
    vi.stubEnv("PASSWORD_RESET_TTL_MINUTES", "241");
    expect(() => tokenDurationMinutes("PASSWORD_RESET_TTL_MINUTES", 20, 240)).toThrow();
  });

  it("accepts only positive bounded whole-feather welcome grants", () => {
    expect(parseWelcomeGrantMilli(undefined)).toBe(1_000_000n);
    expect(parseWelcomeGrantMilli("1")).toBe(1_000n);
    expect(parseWelcomeGrantMilli(" 1000000 ")).toBe(1_000_000_000n);
    for (const value of ["", "0", "-1", "1.5", "1e3", "1000001", "not-a-number"]) {
      expect(() => parseWelcomeGrantMilli(value)).toThrow(WelcomeGrantConfigurationError);
    }
  });
});

describe("SMTP configuration", () => {
  it("fails closed when SMTP is absent or partially authenticated", () => {
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("SMTP_FROM", "");
    expect(() => smtpConfigFromEnvironment()).toThrow(EmailConfigurationError);

    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "587");
    vi.stubEnv("SMTP_FROM", "Goosey <no-reply@example.com>");
    vi.stubEnv("SMTP_USER", "goosey");
    vi.stubEnv("SMTP_PASSWORD", "");
    expect(() => smtpConfigFromEnvironment()).toThrow(EmailConfigurationError);
  });

  it("parses an authenticated TLS SMTP transport only from environment values", () => {
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_SECURE", "true");
    vi.stubEnv("SMTP_REQUIRE_TLS", "true");
    vi.stubEnv("SMTP_FROM", "Goosey <no-reply@example.com>");
    vi.stubEnv("SMTP_REPLY_TO", "support@example.com");
    vi.stubEnv("SMTP_USER", "goosey");
    vi.stubEnv("SMTP_PASSWORD", "secret-from-environment");
    expect(smtpConfigFromEnvironment()).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      requireTLS: true,
      from: "Goosey <no-reply@example.com>",
      replyTo: "support@example.com",
      auth: { user: "goosey", pass: "secret-from-environment" },
    });
  });
});

describe("transactional token consumption", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-auth-recovery-"));
  const databasePath = join(directory, "test.db");
  const databaseUrl = `file:${databasePath}`;
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  let userId = "";
  let resetUserId = "";

  async function createVerificationCandidate(label: string, overrides: { role?: string; status?: string } = {}) {
    const token = randomToken();
    const user = await database.user.create({
      data: {
        email: `${label}@example.com`,
        username: label,
        displayName: label,
        passwordHash: await hashPassword("verification candidate password"),
        role: overrides.role ?? "USER",
        status: overrides.status ?? "ACTIVE",
      },
      select: { id: true },
    });
    await database.accountToken.create({
      data: {
        userId: user.id,
        purpose: EMAIL_VERIFICATION_PURPOSE,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { userId: user.id, token };
  }

  beforeAll(async () => {
    copyFileSync(join(process.cwd(), "prisma/dev.db"), databasePath);
    const user = await database.user.create({
      data: {
        email: "recovery-test@example.com",
        username: "recovery_test",
        displayName: "Recovery Test",
        passwordHash: await hashPassword("original password phrase"),
      },
    });
    userId = user.id;
    const resetUser = await database.user.create({
      data: {
        email: "unverified-reset@example.com",
        username: "unverified_reset",
        displayName: "Unverified Reset",
        passwordHash: await hashPassword("original reset password"),
      },
    });
    resetUserId = resetUser.id;
  }, 30_000);

  afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("consumes verification tokens once and records verification atomically", async () => {
    const token = randomToken();
    await database.accountToken.create({
      data: {
        userId,
        purpose: EMAIL_VERIFICATION_PURPOSE,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await confirmEmailVerificationWithDatabase(database, token);
    const [user, stored, wallet, grant] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: userId } }),
      database.accountToken.findUniqueOrThrow({ where: { tokenHash: sha256(token) } }),
      database.ledgerAccount.findUniqueOrThrow({
        where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: userId, purpose: "USER_FEATHERS" } },
      }),
      database.journalEntry.findUniqueOrThrow({
        where: { idempotencyScope_idempotencyKey: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: userId } },
      }),
    ]);
    expect(result.welcomeGrantIssued).toBe(true);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(user.balanceMilli).toBe(wallet.balanceMilli);
    expect(user.balanceMilli).toBeGreaterThan(0n);
    expect(grant.type).toBe("WELCOME_GRANT");
    expect(stored.consumedAt).toBeInstanceOf(Date);
    await expect(confirmEmailVerificationWithDatabase(database, token)).rejects.toBeInstanceOf(InvalidAccountTokenError);
  });

  it.each([
    ["suspended", { status: "SUSPENDED" }],
    ["wrong_role", { role: "ADMIN" }],
  ])("does not consume the token or verify an ineligible %s account", async (label, overrides) => {
    const candidate = await createVerificationCandidate(`verification_${label}`, overrides);

    await expect(confirmEmailVerificationWithDatabase(database, candidate.token))
      .rejects.toBeInstanceOf(InvalidAccountTokenError);

    const [user, storedToken, grantCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: candidate.userId } }),
      database.accountToken.findUniqueOrThrow({ where: { tokenHash: sha256(candidate.token) } }),
      database.journalEntry.count({
        where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: candidate.userId },
      }),
    ]);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.balanceMilli).toBe(0n);
    expect(storedToken.consumedAt).toBeNull();
    expect(grantCount).toBe(0);
  });

  it("rolls back token consumption and verification when welcome-grant configuration is invalid", async () => {
    const candidate = await createVerificationCandidate("verification_bad_config");
    vi.stubEnv("STARTING_FEATHERS", "-10000");

    await expect(confirmEmailVerificationWithDatabase(database, candidate.token))
      .rejects.toBeInstanceOf(WelcomeGrantConfigurationError);

    const [user, storedToken, grantCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: candidate.userId } }),
      database.accountToken.findUniqueOrThrow({ where: { tokenHash: sha256(candidate.token) } }),
      database.journalEntry.count({
        where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: candidate.userId },
      }),
    ]);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.balanceMilli).toBe(0n);
    expect(storedToken.consumedAt).toBeNull();
    expect(grantCount).toBe(0);
  });

  it("commits exactly one verification and welcome grant under concurrent confirmation", async () => {
    const candidate = await createVerificationCandidate("verification_concurrent");
    const secondToken = randomToken();
    await database.accountToken.create({
      data: {
        userId: candidate.userId,
        purpose: EMAIL_VERIFICATION_PURPOSE,
        tokenHash: sha256(secondToken),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const results = await Promise.allSettled([
      confirmEmailVerificationWithDatabase(database, candidate.token),
      confirmEmailVerificationWithDatabase(database, secondToken),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [user, wallet, grants, auditCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: candidate.userId } }),
      database.ledgerAccount.findUniqueOrThrow({
        where: {
          ownerType_ownerId_purpose: {
            ownerType: "USER",
            ownerId: candidate.userId,
            purpose: "USER_FEATHERS",
          },
        },
      }),
      database.journalEntry.findMany({
        where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: candidate.userId },
      }),
      database.auditLog.count({
        where: { actorUserId: candidate.userId, action: "EMAIL_VERIFIED" },
      }),
    ]);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    expect(grants).toHaveLength(1);
    expect(user.balanceMilli).toBe(parseWelcomeGrantMilli(process.env.STARTING_FEATHERS));
    expect(wallet.balanceMilli).toBe(user.balanceMilli);
    expect(auditCount).toBe(1);
  });

  it("resets the password, revokes every session, and rejects replay", async () => {
    const token = randomToken();
    await database.accountToken.create({
      data: {
        userId: resetUserId,
        purpose: PASSWORD_RESET_PURPOSE,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await database.session.createMany({
      data: [
        { userId: resetUserId, tokenHash: sha256("session-one"), expiresAt: new Date(Date.now() + 60_000) },
        { userId: resetUserId, tokenHash: sha256("session-two"), expiresAt: new Date(Date.now() + 60_000) },
      ],
    });

    const replacement = "a completely new password";
    await confirmPasswordResetWithDatabase(database, token, replacement);
    const [user, sessionCount] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: resetUserId } }),
      database.session.count({ where: { userId: resetUserId } }),
    ]);
    expect(await verifyPassword(replacement, user.passwordHash)).toBe(true);
    expect(await verifyPassword("original reset password", user.passwordHash)).toBe(false);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.balanceMilli).toBe(0n);
    expect(sessionCount).toBe(0);
    await expect(confirmPasswordResetWithDatabase(database, token, replacement)).rejects.toBeInstanceOf(InvalidAccountTokenError);
  });
});
