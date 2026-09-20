import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerUser, createSessionForVerifiedLoginSnapshot, emailVerificationState, grantWelcomeFeathers } from "./auth";
import { createRegistrationDeviceToken } from "./security";

describe("signup without a verification email", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-signup-"));
  const url = `file:${join(directory, "test.db")}`;
  const database = new PrismaClient({ datasourceUrl: url });
  beforeAll(async () => {
    await database.$connect();
    execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await database.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

  it("creates a usable session and grants exactly once without claiming verified ownership", async () => {
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "");
    vi.stubEnv("STARTING_FEATHERS", "1000");
    const registrationDeviceToken = createRegistrationDeviceToken();
    const result = await registerUser({ email: "new@example.com", username: "newgoose", displayName: "New Goose", password: "a long test password", registrationDeviceToken }, database);
    expect(emailVerificationState(result.user).required).toBe(false);
    expect(result.user.emailVerifiedAt).toBeNull();
    expect(result.session.token).toHaveLength(43);
    const user = await database.user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(user.balanceMilli).toBe(1_000_000n);
    await createSessionForVerifiedLoginSnapshot(database, user);
    expect(await database.$transaction(tx => grantWelcomeFeathers(tx, user.id))).toBe(false);
    expect(await database.journalEntry.count({ where: { referenceId: user.id, type: "WELCOME_GRANT" } })).toBe(1);
    expect((await database.user.findUniqueOrThrow({ where: { id: user.id } })).balanceMilli).toBe(1_000_000n);
    expect((await database.ledgerPosting.findMany()).reduce((sum, row) => sum + row.amountMilli, 0n)).toBe(0n);
    expect(await database.accountToken.count()).toBe(0);
    expect(await database.registrationDevice.count()).toBe(1);
    expect((await database.registrationDevice.findFirstOrThrow()).tokenHash).not.toBe(registrationDeviceToken);

    await expect(registerUser({
      email: "second@example.com",
      username: "secondgoose",
      displayName: "Second Goose",
      password: "another long test password",
      registrationDeviceToken,
    }, database)).rejects.toMatchObject({ name: "RegistrationDeviceInUseError" });
    expect(await database.user.count()).toBe(1);
    expect(await database.session.count()).toBe(2);
    expect(await database.journalEntry.count({ where: { type: "WELCOME_GRANT" } })).toBe(1);
  });

  it("still defers the grant when verification is explicitly required", async () => {
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "true");
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_SECURE", "true");
    vi.stubEnv("SMTP_FROM", "Goosey <no-reply@example.com>");
    const result = await registerUser({ email: "optional@example.com", username: "optionalgoose", displayName: "Optional Goose", password: "a long test password" }, database);
    expect(emailVerificationState(result.user).required).toBe(true);
    expect((await database.user.findUniqueOrThrow({ where: { id: result.user.id } })).balanceMilli).toBe(0n);
  });
});
