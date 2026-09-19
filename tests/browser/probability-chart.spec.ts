import { expect, test } from "@playwright/test";

test("probability inspection matches persisted history and resets cleanly", async ({ page, request, isMobile }) => {
  const slug = "gallery-150-projects";
  const response = await request.get(`/api/markets/${slug}/history?range=ALL&limit=2000`);
  expect(response.ok()).toBeTruthy();
  const { snapshots } = await response.json() as { snapshots: { createdAt: string; yesProbabilityBps: number }[] };
  expect(snapshots.length).toBeGreaterThan(0);
  await page.goto(`/markets/${slug}`);
  const chart = page.locator(".full-plot");
  const slider = chart.getByRole("slider");
  const tooltip = chart.getByRole("tooltip", { includeHidden: true });
  await expect(slider).toHaveAttribute("data-inspecting", "false");
  await expect(tooltip).toBeHidden();

  await slider.focus();
  await slider.press("Home");
  await expect(tooltip).toBeVisible();
  await expect(page.getByText("Historical probability", { exact: true })).toBeVisible();
  await slider.press("End");
  const last = snapshots.at(-1)!;
  const label = `${Number((last.yesProbabilityBps / 100).toFixed(2))}%`;
  await expect(tooltip.locator("b")).toHaveText(label);
  await expect(tooltip.locator("time")).toHaveAttribute("datetime", new Date(last.createdAt).toISOString());
  await expect(slider).toHaveAttribute("aria-valuetext", new RegExp(label.replace(".", "\\.")));
  await slider.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(page.getByText("Current forecast", { exact: true }).first()).toBeVisible();

  if (!isMobile) {
    await slider.hover();
    await expect(tooltip).toBeVisible();
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    for (const x of [box!.x + 1, box!.x + box!.width - 1]) {
      await page.mouse.move(x, box!.y + box!.height / 2);
      const bubble = await tooltip.boundingBox();
      expect(bubble!.x).toBeGreaterThanOrEqual(-1);
      expect(bubble!.x + bubble!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    }
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
  } else {
    await slider.tap();
    await expect(slider).toHaveAttribute("data-inspecting", "false");
  }

  await slider.focus();
  await slider.press("Home");
  await page.getByRole("button", { name: "1D", exact: true }).click();
  await expect(slider).toHaveAttribute("data-inspecting", "false");
  await expect(tooltip).toBeHidden();
  await expect(page.getByRole("button", { name: "1D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await slider.focus();
  await slider.press("End");
  await slider.press("Tab");
  await expect(tooltip).toBeHidden();
});

test("card sparklines expose real values to keyboard users in dark mode", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  const card = page.locator(".market-card").first();
  const slider = card.getByRole("slider");
  const tooltip = card.getByRole("tooltip", { includeHidden: true });
  await expect(tooltip).toBeHidden();
  await slider.focus();
  await slider.press("End");
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator("b")).toHaveText(/^\d+(\.\d{1,2})?%$/);
  await expect(tooltip.locator("time")).toHaveAttribute("datetime", /T/);
  await slider.press("Tab");
  await expect(tooltip).toBeHidden();
});
