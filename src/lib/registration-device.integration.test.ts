import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { registerUser } from "./auth";
import { createRegistrationDeviceToken } from "./security";

describe("registration device enforcement", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-registration-device-"));
  const url = `file:${join(directory, "test.db")}`;
  const database = new PrismaClient({ datasourceUrl: url });

  beforeAll(async () => {
    await database.$connect();
    execFileSync(join(process.cwd(), "node_modules/.bin/prisma"), [
      "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate",
    ], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("atomically allows only one concurrent account, grant, and session per device", async () => {
    vi.stubEnv("REQUIRE_EMAIL_VERIFICATION", "");
    vi.stubEnv("STARTING_FEATHERS", "1000");
    const registrationDeviceToken = createRegistrationDeviceToken();
    const attempts = await Promise.allSettled([
      registerUser({ email: "race-one@example.test", username: "race_one", displayName: "Race One", password: "race one password long", registrationDeviceToken }, database),
      registerUser({ email: "race-two@example.test", username: "race_two", displayName: "Race Two", password: "race two password long", registrationDeviceToken }, database),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: { name: "RegistrationDeviceInUseError" } });
    expect(await database.user.count()).toBe(1);
    expect(await database.registrationDevice.count()).toBe(1);
    expect(await database.session.count()).toBe(1);
    expect(await database.journalEntry.count({ where: { type: "WELCOME_GRANT" } })).toBe(1);
  });

  it("does not consume a fresh device when another unique account field fails", async () => {
    const registrationDeviceToken = createRegistrationDeviceToken();
    const existing = await database.user.findFirstOrThrow({ select: { email: true } });
    await expect(registerUser({
      email: existing.email,
      username: "unused_name",
      displayName: "Duplicate email",
      password: "duplicate email password",
      registrationDeviceToken,
    }, database)).rejects.toMatchObject({ code: "P2002" });

    expect(await database.registrationDevice.count()).toBe(1);
    await expect(registerUser({
      email: "retry@example.test",
      username: "retry_user",
      displayName: "Retry User",
      password: "retry user password long",
      registrationDeviceToken,
    }, database)).resolves.toMatchObject({ user: { email: "retry@example.test" } });
    expect(await database.registrationDevice.count()).toBe(2);
  });
});
