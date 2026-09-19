import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { sha256 } from "../../src/lib/security";

test.describe.configure({ mode: "serial" });

test("complete participant and administrator journey", async ({ page, request }, testInfo) => {
  const db = new PrismaClient();
  const suffix = `${testInfo.project.name.replace(/\W+/g, "-")}-${Date.now()}`.toLowerCase();
  const email = `browser-${suffix}@goosey.test`;
  const username = `browser_${suffix.replace(/-/g, "_").slice(-14)}`;
  const password = "Goosey-browser-journey-2026!";
  const adminEmail = `admin-${suffix}@goosey.test`;
  const adminPassword = "Goosey-admin-browser-2026!";
  const comment = `Wi-Fi reliability matters for live demos (${suffix}).`;
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    const expectedUnavailableEmail = url.endsWith("/api/auth/email-verification/request")
      && message.text().includes("503");
    const expectedForbiddenBoundary = url.endsWith("/api/admin/audit-logs")
      && message.text().includes("403");
    if (!expectedUnavailableEmail && !expectedForbiddenBoundary) consoleErrors.push(message.text());
  });

  try {
    await db.user.create({
      data: { email: adminEmail, username: `admin_${suffix.replace(/-/g, "_").slice(-14)}`, displayName: "Browser Journey Admin", passwordHash: await hash(adminPassword, 4), emailVerifiedAt: new Date(), role: "ADMIN", status: "ACTIVE" },
    });

    await test.step("public discovery, search, and anonymous admin boundary", async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Make your call. Win some feathers." })).toBeVisible();
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      if (testInfo.project.name.startsWith("mobile")) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("link", { name: "Search" }).click();
      } else {
        await page.locator("header").getByRole("link", { name: "Search markets" }).click();
      }
      await page.getByRole("searchbox", { name: "Search Goosey" }).fill("Wi-Fi");
      await expect(page.getByRole("heading", { name: "Markets" })).toBeVisible();
      await expect(page.getByRole("link", { name: /Venue Wi-Fi stays up/i })).toBeVisible();
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible();
      expect((await request.get("/api/admin/audit-logs")).status()).toBe(401);
    });

    await test.step("signup is gated until email verification", async () => {
      await page.goto("/signup");
      await page.getByLabel("Username").fill(username);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("checkbox", { name: /community rules/i }).check();
      await page.getByRole("button", { name: /Create account/i }).click();
      await expect(page).toHaveURL(/\/verify-email/);
      await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
      await page.goto("/portfolio");
      await expect(page).toHaveURL(/\/verify-email\?next=%2Fportfolio/);

      const user = await db.user.findUniqueOrThrow({ where: { email } });
      expect(user.balanceMilli).toBe(0n);
      const token = randomBytes(32).toString("base64url");
      await db.accountToken.create({ data: { userId: user.id, purpose: "EMAIL_VERIFICATION", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 60 * 60_000) } });
      await page.goto(`/verify-email?next=%2Fmarkets#token=${token}`);
      await expect(page.getByRole("heading", { name: "You are verified" })).toBeVisible();
      await expect(page).toHaveURL(/\/markets$/);
      const verified = await db.user.findUniqueOrThrow({ where: { email } });
      expect(verified.emailVerifiedAt).not.toBeNull();
      expect(verified.balanceMilli).toBe(1_000_000n);
      expect(await db.registrationInviteClaim.count({ where: { userId: verified.id } })).toBe(0);
    });

    await test.step("logout and login preserve the verified account", async () => {
      await page.goto("/settings/profile");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(false);
      await page.goto("/");
      await page.goto("/login");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: /Sign in/i }).click();
      await expect(page).toHaveURL("/");
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(true);
    });

    await test.step("market detail, two-sided trading, portfolio redemption, and comments", async () => {
      await page.goto("/markets/gallery-150-projects");
      await expect(page.getByRole("heading", { name: /150 projects appear/i })).toBeVisible();
      if (testInfo.project.name.startsWith("mobile")) {
        await page.getByRole("button", { name: /^Trade Yes /i }).click();
      }
      await page.getByRole("button", { name: "Review trade" }).click();
      await page.getByRole("button", { name: "Buy 1 YES" }).click();
      await expect(page.getByRole("heading", { name: "Trade placed" })).toBeVisible();
      await page.getByRole("button", { name: /Make another trade/i }).click();
      await page.getByRole("button", { name: /^No\b/i }).click();
      await page.getByRole("button", { name: "Review trade" }).click();
      await page.getByRole("button", { name: "Buy 1 NO" }).click();
      await expect(page.getByRole("heading", { name: "Trade placed" })).toBeVisible();
      if (testInfo.project.name.startsWith("mobile")) {
        await page.getByRole("button", { name: "Close trade ticket" }).last().click();
      }

      await page.getByLabel("Add a comment").fill(comment);
      await page.getByRole("button", { name: /^Post$/ }).click();
      await expect(page.getByText(comment)).toBeVisible();

      await page.goto("/portfolio");
      await expect(page.getByRole("heading", { name: "Portfolio" })).toBeVisible();
      await expect(page.getByText("Cash out matching YES + NO contracts")).toBeVisible();
      await page.getByRole("button", { name: "Cash out" }).click();
      await expect(page.getByRole("heading", { name: "No open positions" })).toBeVisible();
    });

    await test.step("limit order placement and cancellation use the order-book UI", async () => {
      await page.goto("/markets/venue-wifi-through-demos");
      await expect(page.getByRole("heading", { name: "Place a limit order" })).toBeVisible();
      await page.getByLabel("Limit price (🪶)").fill("1.000");
      await page.getByLabel("Contracts").fill("2");
      await page.getByRole("button", { name: "Place limit order" }).click();
      await expect(page.getByText(/Limit order placed/i)).toBeVisible();
      await expect(page.getByRole("heading", { name: "Open orders" })).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText(/Order canceled and reserved feathers released/i)).toBeVisible();
      await expect(page.getByText("No resting orders in this market.")).toBeVisible();
    });

    await test.step("profile, leaderboard, and ordinary-user admin boundary", async () => {
      await page.goto("/settings/profile");
      await page.getByLabel("Bio").fill("Testing Goosey from signup through settlement-safe trading.");
      await page.getByRole("checkbox", { name: /public profile/i }).check();
      await page.getByRole("checkbox", { name: /public leaderboard/i }).check();
      await page.getByRole("button", { name: "Save profile" }).click();
      await expect(page.getByText("Profile and privacy choices saved.")).toBeVisible();
      await page.goto("/leaderboard");
      await expect(page.getByText("Browser Journey Hacker").first()).toBeVisible();
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible();
      expect(await page.evaluate(async () => (await fetch("/api/admin/audit-logs")).status)).toBe(403);
    });

    await test.step("administrator can sign in, issue, and revoke an invite", async () => {
      await page.goto("/settings/profile");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(false);
      await page.goto("/login");
      await page.getByLabel("Email").fill(adminEmail);
      await page.getByLabel("Password", { exact: true }).fill(adminPassword);
      await page.getByRole("button", { name: /Sign in/i }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(true);
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Market desk" })).toBeVisible();
      await page.getByLabel("Label").fill(`Hack the North check-in ${suffix}`);
      await page.getByLabel("Number of signups").fill("2");
      await page.getByRole("button", { name: "Create invite" }).click();
      await expect(page.getByText(/Copy this code now/i)).toBeVisible();
      const row = page.locator("article.report-item").filter({ hasText: `Hack the North check-in ${suffix}` });
      await expect(row).toContainText("0 of 2 claimed");
      page.once("dialog", (dialog) => dialog.accept());
      await row.getByRole("button", { name: "Revoke" }).click();
      await expect(row).toContainText("REVOKED");
    });

    expect(consoleErrors, `browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await db.$disconnect();
  }
});
