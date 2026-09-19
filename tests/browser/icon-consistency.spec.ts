import { expect, test } from "@playwright/test";

test("market statuses are text-only and feathers share one SVG", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.goto("/markets/gallery-150-projects");
    await expect(page.locator("body")).not.toContainText("🪶");
    await expect(page.locator(".market-icon")).toHaveCount(0);
    const status = page.locator(".market-meta .status-open, .market-meta .status-closed");
    await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const post = page.getByRole("button", { name: "Post", exact: true });
    await expect(post.locator("svg")).toHaveCount(0);
    const feathers = page.locator("svg.feather-icon");
    expect(await feathers.count()).toBeGreaterThan(0);
    const shapes = await feathers.evaluateAll(icons => icons.map(icon => [...icon.querySelectorAll("path,line,polyline")].map(shape => shape.outerHTML).join("")));
    expect(new Set(shapes).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto("/");
    for (const status of await page.locator(".status-pill").all()) {
      await expect(status).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(status).toHaveCSS("padding", "0px");
    }
  }
});
