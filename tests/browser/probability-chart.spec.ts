import { expect, test, type Locator } from "@playwright/test";

const chartSlug = process.env.GOOSEY_CHART_TEST_SLUG ?? "htn-2026-mc-does-67";

test("probability inspection matches persisted history and resets cleanly", async ({ page, request, isMobile }) => {
  const slug = chartSlug;
  const response = await request.get(`/api/markets/${slug}/history?range=ALL&limit=2000`);
  expect(response.ok()).toBeTruthy();
  const { snapshots } = await response.json() as { snapshots: { createdAt: string; yesProbabilityBps: number }[] };
  expect(snapshots.length).toBeGreaterThan(0);
  const historyLoaded = page.waitForResponse(response => response.url().includes(`/api/markets/${slug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${slug}`);
  await historyLoaded;
  const chart = page.locator(".full-plot");
  const slider = chart.getByRole("slider");
  const tooltip = chart.getByRole("tooltip", { includeHidden: true });
  await expect(slider).toHaveAttribute("data-inspecting", "false");
  await expect(tooltip).toBeHidden();

  await slider.focus();
  await slider.press("Home");
  await expect(tooltip).toBeVisible();
  await slider.press("End");
  const last = snapshots.at(-1)!;
  const label = `${Math.floor((last.yesProbabilityBps + 50) / 100)}%`;
  await expect(tooltip.locator("b")).toHaveText(label);
  await expect(page.locator(".probability-chart figcaption .eyebrow")).toHaveText("Held price");
  const heldTimestamp = await tooltip.locator("time").getAttribute("datetime");
  expect(Date.parse(heldTimestamp!)).toBeGreaterThan(Date.parse(last.createdAt));
  // Keyboard inspection moves through time, including gaps without observations.
  await slider.press("ArrowLeft");
  expect(Date.parse((await tooltip.locator("time").getAttribute("datetime"))!)).toBe(Date.parse(heldTimestamp!) - 600_000);
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
  await page.getByRole("button", { name: "24H", exact: true }).click();
  await expect(slider).toHaveAttribute("data-inspecting", "false");
  await expect(tooltip).toBeHidden();
  await expect(page.getByRole("button", { name: "24H", exact: true })).toHaveAttribute("aria-pressed", "true");
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
  await expect(tooltip.locator("b")).toHaveText(/^\d+%$/);
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
  await page.route(`**/api/markets/${chartSlug}/history?**`, async route => {
    const response = await route.fetch();
    loaded();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/markets/${chartSlug}`);
    await fetched;
    const figure = page.locator(".probability-chart");
    const slider = figure.getByRole("slider");
    const tooltip = figure.getByRole("tooltip", { includeHidden: true });
    await slider.focus();
    await slider.press("Home");
    await expect(tooltip).toBeVisible();
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
  const initial = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${chartSlug}`);
  expect((await initial).ok()).toBeTruthy();
  await expect(page.getByRole("button", { name: "1H", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const range of ["4H", "8H", "24H", "ALL", "1H"]) {
    const received = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === range);
    await page.getByRole("button", { name: range, exact: true }).click();
    const response = await received;
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.range).toBe(range);
    await expect(page.getByRole("button", { name: range, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".probability-chart").getByRole("tooltip", { includeHidden: true })).toBeHidden();
  }
});


async function chartGeometry(figure: Locator) {
  return figure.evaluate(element => {
    const box = element.getBoundingClientRect();
    const plot = element.querySelector(".probability-plot-surface")!.getBoundingClientRect();
    const footer = element.querySelector(".probability-chart-footer")!.getBoundingClientRect();
    return { height: box.height, plotHeight: plot.height, plotTop: plot.top - box.top, footerTop: footer.top - box.top };
  });
}

test("inspection and range changes keep the chart and controls in place", async ({ page, isMobile }) => {
  const historyLoaded = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${chartSlug}`);
  await historyLoaded;
  const figure = page.locator(".probability-chart");
  const slider = figure.getByRole("slider");
  await expect(slider).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const original = await chartGeometry(figure);
  async function expectStableGeometry() {
    await expect.poll(async () => {
      const current = await chartGeometry(figure);
      return Math.max(...Object.keys(original).map(key => Math.abs(current[key as keyof typeof current] - original[key as keyof typeof original])));
    }).toBeLessThanOrEqual(1);
  }
  await slider.focus();
  for (const key of ["Home", "End", "Escape"]) {
    await slider.press(key);
    await expectStableGeometry();
  }
  if (!isMobile) {
    const box = await slider.boundingBox();
    for (const ratio of [0.01, 0.5, 0.99]) {
      await page.mouse.move(box!.x + box!.width * ratio, box!.y + box!.height / 2);
      await expect(slider).toHaveAttribute("data-inspecting", "true");
      await expectStableGeometry();
    }
    await page.mouse.move(0, 0);
    await expectStableGeometry();
  }
  for (const range of ["4H", "8H", "24H", "ALL", "1H"]) {
    const loaded = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === range);
    await figure.getByRole("button", { name: range, exact: true }).click();
    expect((await loaded).ok()).toBeTruthy();
    await expect(slider).toHaveAttribute("data-inspecting", "false");
    await expectStableGeometry();
    await slider.focus();
    await slider.press("End");
    await expect(figure.locator("figcaption .eyebrow")).toHaveText("Held price");
    await expectStableGeometry();
  }
});

test("held price advances from server time without creating another observation", async ({ page, request }) => {
  const slug = chartSlug;
  const historyUrl = `/api/markets/${slug}/history?range=ALL&limit=2000`;
  const response = await request.get(historyUrl);
  expect(response.ok()).toBeTruthy();
  const before = await response.json() as { asOf: string; snapshots: { createdAt: string; yesProbabilityBps: number }[] };
  const last = before.snapshots.at(-1);
  expect(last).toBeDefined();
  let serverAsOf = Math.max(Date.parse(before.asOf), Date.parse(last!.createdAt) + 74 * 60_000);
  await page.route(`**/api/markets/${slug}/history?**`, async route => {
    const upstream = await route.fetch();
    const body = await upstream.json();
    await route.fulfill({ response: upstream, json: { ...body, asOf: new Date(serverAsOf).toISOString() } });
  });
  // Deliberately wrong client wall clock: the chart domain must follow API asOf.
  await page.clock.install({ time: serverAsOf + 7 * 86_400_000 });
  const loaded = page.waitForResponse(response => response.url().includes(`/api/markets/${slug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${slug}`);
  await loaded;
  const figure = page.locator(".probability-chart");
  const slider = figure.getByRole("slider");
  const tooltip = figure.getByRole("tooltip", { includeHidden: true });
  await slider.focus();
  await slider.press("End");
  await expect(figure.locator("figcaption .eyebrow")).toHaveText("Held price");
  const firstHeldTime = Date.parse((await tooltip.locator("time").getAttribute("datetime"))!);
  expect(firstHeldTime).toBe(serverAsOf);
  const price = `${Math.floor((last!.yesProbabilityBps + 50) / 100)}%`;
  await expect(tooltip.locator("b")).toHaveText(price);
  await page.evaluate(() => document.fonts.ready);
  const original = await chartGeometry(figure);
  serverAsOf += 10 * 60_000;
  const refreshed = page.waitForResponse(response => response.url().includes(`/api/markets/${slug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.clock.fastForward(10 * 60_000);
  await refreshed;
  await expect(slider).toHaveAttribute("data-inspecting", "false");
  await slider.focus();
  await slider.press("End");
  const advancedTime = Date.parse((await tooltip.locator("time").getAttribute("datetime"))!);
  expect(advancedTime - firstHeldTime).toBe(10 * 60_000);
  await expect(tooltip.locator("b")).toHaveText(price);
  expect(await chartGeometry(figure)).toEqual(original);
  await slider.press("ArrowLeft");
  expect(Math.abs(Date.parse((await tooltip.locator("time").getAttribute("datetime"))!) - (advancedTime - 600_000))).toBeLessThan(1000);
  await expect(tooltip.locator("b")).toHaveText(price);
  const afterResponse = await request.get(historyUrl);
  expect(afterResponse.ok()).toBeTruthy();
  const after = await afterResponse.json() as typeof before;
  expect(after.snapshots).toEqual(before.snapshots);
  await page.unrouteAll({ behavior: "wait" });
});


test("scrubbing a sparse history follows pointer time rather than observation timestamps", async ({ page, isMobile }, testInfo) => {
  const loaded = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${chartSlug}`);
  await loaded;
  const figure = page.locator(".probability-chart");
  const slider = figure.getByRole("slider");
  const tooltip = figure.getByRole("tooltip", { includeHidden: true });
  await slider.scrollIntoViewIfNeeded();
  await expect(slider).toBeVisible();
  const box = (await slider.boundingBox())!;
  const start = Number(await slider.getAttribute("aria-valuemin"));
  const end = Number(await slider.getAttribute("aria-valuemax"));
  const original = await chartGeometry(figure);
  const timestamps: number[] = [];
  for (const ratio of [0.2, 0.21, 0.22, 0.6, 0.61, 0.62]) {
    const clientX = box.x + box.width * ratio;
    if (isMobile) await slider.dispatchEvent("pointermove", { clientX, pointerType: "touch", buttons: 1 });
    else await page.mouse.move(clientX, box.y + box.height / 2);
    await expect(tooltip).toBeVisible();
    const time = Date.parse((await tooltip.locator("time").getAttribute("datetime"))!);
    expect(Math.abs(time - (start + ratio * (end - start)))).toBeLessThan(1000);
    timestamps.push(time);
    expect(await chartGeometry(figure)).toEqual(original);
  }
  expect(new Set(timestamps).size).toBe(timestamps.length);
  await figure.screenshot({ path: `output/playwright/chart-continuous-${testInfo.project.name}.png` });
  await slider.focus();
  await slider.press("ArrowLeft");
  expect(Date.parse((await tooltip.locator("time").getAttribute("datetime"))!)).toBe(timestamps.at(-1)! - 600_000);
  await slider.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("sparse history holds the last committed probability and uses server asOf", async ({ page, isMobile }) => {
  const asOf = Date.parse("2026-09-19T20:00:00.000Z");
  const rangeStart = asOf - 3_600_000;
  const snapshots = [
    { id: "prior", marketId: "market", createdAt: new Date(rangeStart - 600_000).toISOString(), yesProbabilityBps: 5_000 },
    { id: "first", marketId: "market", createdAt: new Date(rangeStart + 15 * 60_000).toISOString(), yesProbabilityBps: 5_123 },
    { id: "second", marketId: "market", createdAt: new Date(rangeStart + 45 * 60_000).toISOString(), yesProbabilityBps: 4_876 },
  ];
  await page.route(`**/api/markets/${chartSlug}/history?**`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      asOf: new Date(asOf).toISOString(),
      range: "1H",
      rangeStart: new Date(rangeStart).toISOString(),
      snapshots,
      currentProbabilityYesBps: 4_876,
      sampledFrom: snapshots.length,
      downsampled: false,
      source: "PROBABILITY",
      trades: [],
    }),
  }));
  // A client clock a week ahead must not move the chart beyond the server watermark.
  await page.clock.install({ time: asOf + 7 * 86_400_000 });
  const loaded = page.waitForResponse(response => response.url().includes(`/api/markets/${chartSlug}/history?`) && new URL(response.url()).searchParams.get("range") === "1H");
  await page.goto(`/markets/${chartSlug}`);
  await loaded;

  const figure = page.locator(".probability-chart");
  const slider = figure.getByRole("slider");
  const tooltip = figure.getByRole("tooltip", { includeHidden: true });
  await expect(slider).toHaveAttribute("aria-valuemin", String(rangeStart));
  await expect(slider).toHaveAttribute("aria-valuemax", String(asOf));
  await expect(figure.locator(".probability-tick")).toHaveText(["100%", "50%", "0%"]);
  await expect(figure.locator(".probability-line").first()).toHaveAttribute("d", / H .* V /);
  await expect(figure.locator(".probability-line").first()).not.toHaveAttribute("d", / C /);

  const box = (await slider.boundingBox())!;
  for (const [ratio, expected] of [[0.10, "50%"], [0.40, "51%"], [0.90, "49%"]] as const) {
    const clientX = box.x + box.width * ratio;
    if (isMobile) await slider.dispatchEvent("pointermove", { clientX, pointerType: "touch", buttons: 1 });
    else await page.mouse.move(clientX, box.y + box.height / 2);
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator("b")).toHaveText(expected);
  }
});
