import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSessionForVerifiedLoginSnapshot, hashPassword } from "./auth";

describe("login versus password-reset session revocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-login-race-"));
  const databasePath = join(directory, "test.db");
  const database = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  let userId = "";
  let oldPasswordHash = "";

  beforeAll(async () => {
    copyFileSync(join(process.cwd(), "prisma/dev.db"), databasePath);
    oldPasswordHash = await hashPassword("old password verified before reset");
    const user = await database.user.create({
      data: {
        email: "login-reset-race@example.com",
        username: "login_reset_race",
        displayName: "Login Reset Race",
        passwordHash: oldPasswordHash,
      },
      select: { id: true },
    });
    userId = user.id;
  }, 30_000);

  afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("does not create a session after the verified password snapshot was reset", async () => {
    const verifiedSnapshot = await database.user.findUniqueOrThrow({ where: { id: userId } });
    await database.$transaction([
      database.user.update({
        where: { id: userId },
        data: { passwordHash: await hashPassword("new password committed by reset") },
      }),
      database.session.deleteMany({ where: { userId } }),
    ]);

    const result = await createSessionForVerifiedLoginSnapshot(database, verifiedSnapshot);

    expect(result).toBeNull();
    expect(await database.session.count({ where: { userId } })).toBe(0);
  });

  it("still issues a session for the current active credential snapshot", async () => {
    const currentSnapshot = await database.user.findUniqueOrThrow({ where: { id: userId } });

    const result = await createSessionForVerifiedLoginSnapshot(database, currentSnapshot);

    expect(result?.user.id).toBe(userId);
    expect(result?.session.token).toHaveLength(43);
    expect(await database.session.count({ where: { userId } })).toBe(1);
  });
});
