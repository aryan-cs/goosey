import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";
import { sha256 } from "../../src/lib/security";

test("a verification link opened signed out leads through login to the intended page", async ({ page }, testInfo) => {
  const db = new PrismaClient();
  const identity = randomBytes(8).toString("hex");
  const email = `verify-${identity}@goosey.test`;
  const password = "Verification-journey-2026!";
  const token = randomBytes(32).toString("base64url");
  try {
    const user = await db.user.create({ data: {
      email, username: `verify_${identity}`, displayName: `Verification ${testInfo.project.name}`,
      passwordHash: await hash(password, 4), role: "USER", status: "ACTIVE",
    } });
    await db.accountToken.create({ data: {
      userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + 60_000),
    } });
    await page.goto("/verify-email?next=%2Fportfolio");
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    // Same-document navigation must consume a newly arrived email fragment.
    await page.evaluate((value) => { window.location.hash = `token=${value}`; }, token);
    await expect(page.getByRole("heading", { name: "You are verified" })).toBeVisible();
    await expect(page).toHaveURL("/login?next=%2Fportfolio");
    expect((await page.context().cookies()).some((cookie) => cookie.name === "goosey_session")).toBe(false);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/portfolio");
    await expect(page.getByRole("heading", { name: "Portfolio", exact: true })).toBeVisible();
    const verified = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verified.emailVerifiedAt).not.toBeNull();
    expect(verified.balanceMilli).toBe(1_000_000n);
  } finally {
    await db.$disconnect();
  }
});

for (const session of ["token owner", "different verified account", "signed out"] as const) {
  test(`a consumed verification link recovers safely with ${session}`, async ({ page, baseURL }) => {
    const db = new PrismaClient();
    const identity = randomBytes(8).toString("hex");
    const password = "Verification-recovery-2026!";
    const token = randomBytes(32).toString("base64url");
    const destination = "/portfolio?tab=positions#holdings";
    try {
      const owner = await db.user.create({ data: {
        email: `recover-${identity}@goosey.test`, username: `recover_${identity}`,
        displayName: "Verification link owner", passwordHash: await hash(password, 4),
        role: "USER", status: "ACTIVE", emailVerifiedAt: new Date(), balanceMilli: 0n,
      } });
      await db.accountToken.create({ data: {
        userId: owner.id, purpose: "EMAIL_VERIFICATION", tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date(),
      } });
      if (session !== "signed out") {
        const current = session === "token owner" ? owner : await db.user.create({ data: {
          email: `other-${identity}@goosey.test`, username: `other_${identity}`,
          displayName: "Different current account", passwordHash: await hash(password, 4),
          role: "USER", status: "ACTIVE", emailVerifiedAt: new Date(), balanceMilli: 0n,
        } });
        const login = await page.request.post("/api/auth/login", {
          headers: { Origin: baseURL! }, data: { email: current.email, password },
        });
        expect(login.ok()).toBe(true);
      }
      await page.goto(`/verify-email?next=${encodeURIComponent(destination)}#token=${token}`);
      const card = page.getByRole("region", { name: "Verification link unavailable" });
      await expect(card).toBeVisible();
      await expect(card.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("heading", { name: "You are verified", exact: true })).toHaveCount(0);
      // A rejected token must not reveal whose email address it belongs to.
      await expect(card).not.toContainText(owner.email);
      if (session === "signed out") {
        await expect(card.getByRole("link", { name: "Continue", exact: true })).toHaveCount(0);
        const signIn = card.getByRole("link", { name: "Sign in to continue" });
        await expect(signIn).toHaveAttribute("href", `/login?next=${encodeURIComponent(destination)}`);
        await signIn.click();
        await expect(page).toHaveURL(`/login?next=${encodeURIComponent(destination)}`);
      } else {
        await expect(card).toContainText("Your currently signed-in account is already verified");
        await expect(card).toContainText("this does not confirm the rejected link");
        await expect(card.getByRole("button", { name: /Send a new link|Resend email/ })).toHaveCount(0);
        const proceed = card.getByRole("link", { name: "Continue", exact: true });
        await expect(proceed).toHaveAttribute("href", destination);
        await proceed.click();
        await expect(page).toHaveURL(destination);
      }
      expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).balanceMilli).toBe(0n);
      expect(await db.journalEntry.count({ where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: owner.id } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
}

test("failed initial verification delivery does not claim a link was sent", async ({ page, baseURL }) => {
  const db = new PrismaClient();
  const identity = randomBytes(8).toString("hex");
  const password = "Verification-delivery-2026!";
  try {
    const user = await db.user.create({ data: {
      email: `delivery-${identity}@goosey.test`, username: `deliver_${identity}`,
      displayName: "Pending verification", passwordHash: await hash(password, 4),
      role: "USER", status: "ACTIVE", balanceMilli: 0n,
    } });
    const login = await page.request.post("/api/auth/login", {
      headers: { Origin: baseURL! }, data: { email: user.email, password },
    });
    expect(login.ok()).toBe(true);
    await page.addInitScript(() => sessionStorage.setItem("goosey:verification-request-status", "failed"));
    await page.goto("/verify-email?next=%2Fportfolio");
    const card = page.getByRole("region", { name: "Check your email" });
    await expect(card.getByRole("alert")).toContainText("we could not send the email");
    await expect(card).not.toContainText("We sent a link");
    await expect(card).not.toContainText("We sent a verification link");
    await expect(card.getByRole("button", { name: "Resend email" })).toBeEnabled();
  } finally {
    await db.$disconnect();
  }
});
