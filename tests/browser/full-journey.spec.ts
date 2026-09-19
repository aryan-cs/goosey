import { randomBytes } from "node:crypto";

import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { sha256 } from "../../src/lib/security";

test.describe.configure({ mode: "serial" });

function isolatedDatabaseOnly(baseURL: string | undefined) {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    baseURL !== "http://127.0.0.1:8081" ||
    process.env.DATABASE_PROVIDER === "postgresql" ||
    !databaseUrl?.startsWith("file:") ||
    /(?:^|\/)dev\.db(?:$|[?#])/u.test(databaseUrl)
  ) {
    throw new Error("Full-journey browser fixtures require a disposable SQLite database and http://127.0.0.1:8081.");
  }
}

test("complete participant and administrator journey", async ({ page, request, baseURL }, testInfo) => {
  isolatedDatabaseOnly(baseURL);
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
  const suffix = `${testInfo.project.name.replace(/\W+/g, "-")}-${Date.now()}`.toLowerCase();
  const email = `browser-${suffix}@goosey.test`;
  const username = `browser_${suffix.replace(/-/g, "_").slice(-14)}`;
  const password = "Goosey-browser-journey-2026!";
  const adminEmail = `admin-${suffix}@goosey.test`;
  const adminPassword = "Goosey-admin-browser-2026!";
  const orderBookSlug = `journey-orders-${suffix}`;
  const comment = `The published resolution source makes this outcome verifiable (${suffix}).`;
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
    const seededMarket = await db.market.findFirst({
      where: {
        pricingModel: "LMSR", status: "OPEN", acceptingOrders: true,
        closesAt: { gt: new Date() }, liquidityParameter: { gt: 0 },
        collateralAccount: { balanceMilli: { gt: 0n } },
      },
      orderBy: { slug: "asc" },
      select: { slug: true, title: true, shortTitle: true },
    });
    expect(seededMarket, "The isolated seed must contain an open, funded LMSR market with a future close.").not.toBeNull();
    if (!seededMarket) throw new Error("No funded open LMSR market available for the full journey.");
    const admin = await db.user.create({
      data: { email: adminEmail, username: `admin_${suffix.replace(/-/g, "_").slice(-14)}`, displayName: "Browser Journey Admin", passwordHash: await hash(adminPassword, 4), emailVerifiedAt: new Date(), role: "ADMIN", status: "ACTIVE" },
    });

    await db.market.create({ data: {
      slug: orderBookSlug, title: "Journey limit orders", shortTitle: "Journey orders",
      description: "Isolated browser integration market.", rules: "Used only by the automated journey.",
      resolutionSource: "Automated test", category: "Tests", pricingModel: "ORDER_BOOK", status: "OPEN",
      feeBps: 100, payoutMilli: 100_000n,
      closesAt: new Date(Date.now() + 86_400_000), resolvesAt: new Date(Date.now() + 172_800_000),
      createdBy: { connect: { id: admin.id } },
      collateralAccount: { create: { ownerType: "MARKET", ownerId: orderBookSlug, purpose: "MARKET_COLLATERAL" } },
    } });

    await test.step("public discovery, search, and anonymous admin boundary", async () => {
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1, name: "Nize your beak fam. Man's on his bread.", exact: true })).toBeVisible();
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      if (testInfo.project.name.startsWith("mobile")) {
        await page.getByRole("button", { name: "Open menu" }).click();
        await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Search markets", exact: true }).click();
      } else {
        await page.locator("header").getByRole("button", { name: "Search markets", exact: true }).click();
      }
      const searchDialog = page.getByRole("dialog", { name: "Search Goosey", exact: true });
      await expect(searchDialog).toBeVisible();
      await searchDialog.getByRole("searchbox", { name: "Search Goosey" }).fill(seededMarket.shortTitle);
      await expect(searchDialog.getByRole("heading", { name: "Markets", exact: true })).toBeVisible();
      const marketResult = searchDialog.locator(`a[href="/markets/${seededMarket.slug}"]`);
      await expect(marketResult).toBeVisible();
      await expect(marketResult.getByText(seededMarket.shortTitle, { exact: true })).toBeVisible();
      await searchDialog.getByRole("button", { name: "Close search" }).click();
      await expect(searchDialog).not.toBeVisible();
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
      await page.goto("/settings/security");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(false);
      await page.goto("/");
      await page.goto("/login?next=%2Fwatchlist");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: /Sign in/i }).click();
      await expect(page).toHaveURL("/watchlist");
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(true);
    });

    await test.step("market detail, two-sided trading, portfolio redemption, and comments", async () => {
      await page.goto(`/markets/${seededMarket.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: seededMarket.title, exact: true })).toBeVisible();
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
      await page.goto(`/markets/${orderBookSlug}`);
      await expect(page.getByRole("heading", { name: "Place a limit order" })).toBeVisible();
      await page.getByLabel(/^Limit price/).fill("1.000");
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
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
      await page.goto("/settings/privacy");
      await page.getByRole("checkbox", { name: /public profile/i }).check();
      await page.getByRole("checkbox", { name: /appear on the leaderboard/i }).check();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Privacy choices saved.", { exact: true })).toBeVisible();
      await page.goto("/leaderboard");
      await expect(page.getByText(username, { exact: true }).first()).toBeVisible();
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Administrator access required" })).toBeVisible();
      expect(await page.evaluate(async () => (await fetch("/api/admin/audit-logs")).status)).toBe(403);
    });

    await test.step("participant can submit a suggestion and see its persisted history", async () => {
      const title = `Will all scheduled workshops run? ${suffix}`;
      await page.goto("/markets/suggest");
      await page.getByLabel("What should people predict?").fill(title);
      await page.getByRole("combobox", { name: /^Category/ }).selectOption("Workshops");
      await page.getByLabel("How should this be decided?").fill("Check the official organizer workshop schedule after the event and count each session that ran.");
      await page.getByRole("button", { name: "Send suggestion", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Suggestion sent" })).toBeVisible();
      await expect(page.locator(".form-error")).toHaveCount(0);
      await expect(page.locator("article.report-item").filter({ hasText: title })).toBeVisible();
      await page.getByRole("button", { name: "Suggest another" }).click();
      await expect(page.getByLabel("What should people predict?")).toHaveValue("");
    });

    await test.step("administrator can sign in, issue, and revoke an invite", async () => {
      await page.goto("/settings/security");
      await page.getByRole("button", { name: "Sign out" }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(false);
      await page.goto("/login?next=%2Fadmin");
      await page.getByLabel("Email").fill(adminEmail);
      await page.getByLabel("Password", { exact: true }).fill(adminPassword);
      await page.getByRole("button", { name: /Sign in/i }).click();
      await expect.poll(async () =>
        (await page.context().cookies()).some((cookie) => cookie.name === "goosey_session"),
      ).toBe(true);
      await expect(page).toHaveURL("/admin");
      await expect(page.getByRole("heading", { name: "Market desk" })).toBeVisible();
      await page.getByLabel("Label").fill(`Hack the North check-in ${suffix}`);
      await page.getByLabel("Number of signups").fill("2");
      await page.getByRole("button", { name: "Create invite" }).click();
      await expect(page.getByText(/Copy this code now/i)).toBeVisible();
      await expect(page.getByLabel("Label", { exact: true })).toHaveValue("");
      await expect(page.locator(".form-error")).toHaveCount(0);
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
