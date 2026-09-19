import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

test("account pages retain the destination across signup and recovery", async ({ page }) => {
  const next = "/portfolio/activity?tab=fills";
  const query = `?next=${encodeURIComponent(next)}`;
  await page.goto(`/login${query}`);
  await page.locator(".auth-switch").getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(`/signup${query}`);
  await page.locator(".auth-switch").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`/login${query}`);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(`/reset-password${query}`);
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(`/login${query}`);
});

test("saving a market while signed out retains the market destination", async ({ page }) => {
  const db = new PrismaClient();
  const persisted = await db.market.findFirst({ where: { status: { not: "DRAFT" } }, orderBy: { id: "asc" }, select: { slug: true } })
    .finally(() => db.$disconnect());
  expect(persisted, "The isolated browser database must contain a public market").not.toBeNull();
  const market = `/markets/${persisted!.slug}`;
  await page.goto(market);
  await page.getByRole("button", { name: "Add to watchlist", exact: true }).first().click();
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(market)}`);
});
