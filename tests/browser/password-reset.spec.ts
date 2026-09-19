import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { sha256 } from "../../src/lib/security";

test("password recovery request and one-use confirmation work on the real UI", async ({ page }, testInfo) => {
  const db = new PrismaClient();
  const suffix = `${testInfo.project.name}-${Date.now()}`.replace(/\W+/g, "-").toLowerCase();
  const email = `recovery-${suffix}@goosey.test`;
  const oldPassword = "Goosey-recovery-old-2026!";
  const newPassword = "Goosey-recovery-new-2026!";
  const token = randomBytes(32).toString("base64url");
  try {
    const user = await db.user.create({
      data: {
        email,
        username: `recovery_${suffix.replace(/-/g, "_").slice(-14)}`,
        displayName: "Recovery Journey Hacker",
        passwordHash: await hash(oldPassword, 4),
        emailVerifiedAt: new Date(),
        role: "USER",
        status: "ACTIVE",
      },
    });
    await db.accountToken.create({
      data: { userId: user.id, purpose: "PASSWORD_RESET", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 30 * 60_000) },
    });

    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.locator(".form-error")).toContainText("temporarily unavailable");

    await page.goto(`/reset-password#token=${token}`);
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel("New password", { exact: true }).fill(newPassword);
    await page.getByLabel("Confirm new password").fill(newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByRole("heading", { name: "Your account is secure" })).toBeVisible();
    await expect(page).toHaveURL(/\/reset-password$/);

    await page.locator("#main-content").getByRole("link", { name: "Sign in" }).click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/");

    const consumed = await db.accountToken.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(consumed.consumedAt).not.toBeNull();
  } finally {
    await db.$disconnect();
  }
});
