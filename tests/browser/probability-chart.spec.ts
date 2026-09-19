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

test("desktop market list charts receive pointer input above the row navigation link", async ({ page, isMobile }) => {
  test.skip(isMobile, "List charts are intentionally hidden below the desktop breakpoint.");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/markets");
  const row = page.locator(".market-list-row").filter({ has: page.getByRole("slider") }).first();
  const slider = row.locator(".compact-plot").getByRole("slider");
  const tooltip = row.getByRole("tooltip", { includeHidden: true });
  await slider.hover();
  await expect(slider).toHaveAttribute("data-inspecting", "true");
  await expect(tooltip).toBeVisible();
  await expect(page).toHaveURL(/\/markets$/);
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  const link = row.locator(".market-list-main");
  const href = await link.getAttribute("href");
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});

test("recorded zero changes display neutrally without positive arrows", async ({ page }) => {
  await page.goto("/");
  const zeros = page.locator(".market-card small[aria-label]").filter({ hasText: /^0 ptslast change$/ });
  const count = await zeros.count();
  test.skip(count === 0, "The current real market dataset contains no zero-change cards.");
  for (let index = 0; index < count; index += 1) {
    const movement = zeros.nth(index);
    await expect(movement).toHaveClass("movement-flat");
    await expect(movement.locator("svg")).toHaveCount(0);
    await expect(movement).toHaveAttribute("aria-label", "Last change: 0 percentage points, unchanged");
    await expect(movement).not.toContainText("+");
  }
});

test("keyboard chart inspection survives an incidental pointer leave", async ({ page, isMobile }) => {
  test.skip(isMobile, "This regression requires a mouse alongside keyboard interaction.");
  await page.goto("/");
  const card = page.locator(".market-card").filter({ has: page.getByRole("slider") }).first();
  const slider = card.getByRole("slider");
  const tooltip = card.getByRole("tooltip", { includeHidden: true });
  await slider.hover();
  await slider.focus();
  await slider.press("Home");
  const selected = await slider.getAttribute("aria-valuetext");
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuetext", selected!);
  await slider.press("Tab");
  await expect(tooltip).toBeHidden();
});

test("a completed real history request clears both headline and plot inspection", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let loaded!: () => void;
  const fetched = new Promise<void>(resolve => { loaded = resolve; });
  await page.route("**/api/markets/gallery-150-projects/history?**", async route => {
    const response = await route.fetch();
    loaded();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto("/markets/gallery-150-projects");
    await fetched;
    const figure = page.locator(".probability-chart");
    const slider = figure.getByRole("slider");
    const tooltip = figure.getByRole("tooltip", { includeHidden: true });
    await slider.focus();
    await slider.press("Home");
    await expect(tooltip).toBeVisible();
    await expect(figure.locator("figcaption .eyebrow")).toHaveText("Historical probability");
    release();
    await expect(slider).toHaveAttribute("data-inspecting", "false");
    await expect(tooltip).toBeHidden();
    await expect(figure.locator("figcaption .eyebrow")).toHaveText("Current forecast");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("each chart range requests its own persisted observations", async ({ page }) => {
  const initial = page.waitForResponse(response => response.url().includes("/api/markets/gallery-150-projects/history?") && new URL(response.url()).searchParams.get("range") === "ALL");
  await page.goto("/markets/gallery-150-projects");
  expect((await initial).ok()).toBeTruthy();
  for (const range of ["1D", "1W", "1M", "ALL"]) {
    const received = page.waitForResponse(response => response.url().includes("/api/markets/gallery-150-projects/history?") && new URL(response.url()).searchParams.get("range") === range);
    await page.getByRole("button", { name: range, exact: true }).click();
    const response = await received;
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.range).toBe(range);
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".probability-chart").getByRole("tooltip", { includeHidden: true })).toBeHidden();
  }
});
