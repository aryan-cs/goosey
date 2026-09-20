import { expect, test } from "@playwright/test";

const marketSlug = process.env.GOOSEY_CHART_TEST_SLUG ?? "htn-2026-mc-does-67";

test("market activity uses the browser timezone and background refresh keeps the viewport", async ({ page }) => {
  await page.goto(`/markets/${marketSlug}`);

  const timestamp = page.locator(".market-meta time").first();
  await expect(timestamp).toBeVisible();
  const instant = await timestamp.getAttribute("datetime");
  expect(instant).toBeTruthy();
  const expected = await page.evaluate((value) => new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value)), instant!);
  await expect(timestamp).toHaveText(expected);

  await page.getByRole("heading", { name: "Recent activity" }).scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -80));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  const refreshed = page.waitForResponse((response) => response.request().headers().rsc === "1" && response.url().includes(`/markets/${marketSlug}`));
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await refreshed;
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(before, 0);
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeInViewport();
});
