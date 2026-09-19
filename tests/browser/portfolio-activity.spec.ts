import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Locator } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

function isolatedDatabaseOnly(baseURL: string | undefined) {
  if (process.env.DATABASE_URL !== "file:./browser-e2e.db"
    || process.env.DATABASE_PROVIDER === "postgresql"
    || baseURL !== "http://127.0.0.1:8081") {
    throw new Error("Portfolio activity fixtures require DATABASE_URL=file:./browser-e2e.db and http://127.0.0.1:8081. Development and production targets are prohibited.");
  }
}

function fact(card: Locator, label: string) {
  return card.locator("dl > div").filter({ has: card.page().getByText(label, { exact: true }) }).locator("dd");
}

function feathers(value: string) {
  const amount = BigInt(value);
  const fraction = (amount % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${(amount / 1000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""} feathers`;
}

test("private activity shows real NO prices, fills, pagination, recovery and empty states", async ({ page, playwright, baseURL }, testInfo) => {
  isolatedDatabaseOnly(baseURL);
  const db = new PrismaClient({ datasourceUrl: "file:./browser-e2e.db" });
  const suffix = randomUUID();
  const password = "Goosey-activity-browser-2026!";
  const contexts: APIRequestContext[] = [];
  const sessionCookies = new Map<APIRequestContext, string>();
  try {
    const passwordHash = await hash(password, 4);
    const users = await Promise.all(["owner", "counterparty", "empty"].map(async role => {
      const user = await db.user.create({ data: {
        email: `${role}-${suffix}@goosey.test`, username: `${role}_${suffix.replaceAll("-", "").slice(0, 16)}`,
        displayName: `Activity test ${role}`, passwordHash, emailVerifiedAt: new Date(),
        role: "USER", status: "ACTIVE", balanceMilli: 100_000_000n,
      } });
      await db.ledgerAccount.create({ data: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS", balanceMilli: user.balanceMilli } });
      return user;
    }));
    const market = await db.market.create({ data: {
      slug: `activity-${suffix}`, title: "Portfolio activity browser regression", shortTitle: "Activity regression",
      description: "Isolated browser regression market.", rules: "Only used by automated tests.", resolutionSource: "Automated test",
      category: "Tests", pricingModel: "ORDER_BOOK", status: "OPEN", feeBps: 100, payoutMilli: 100_000n,
      closesAt: new Date(Date.now() + 86_400_000), resolvesAt: new Date(Date.now() + 172_800_000),
      createdBy: { connect: { id: users[0].id } },
      collateralAccount: { create: { ownerType: "MARKET", ownerId: `activity-${suffix}`, purpose: "MARKET_COLLATERAL" } },
    } });
    async function login(request: APIRequestContext, email: string) {
      const response = await request.post("/api/auth/login", { headers: { Origin: baseURL! }, data: { email, password } });
      expect(response.status(), await response.text()).toBe(200);
      const cookie = response.headers()["set-cookie"].split(";")[0];
      sessionCookies.set(request, cookie);
      if (request === page.request) {
        // Production emits Secure cookies. The guarded loopback test server uses HTTP.
        const separator = cookie.indexOf("=");
        await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseURL!, secure: false, httpOnly: true, sameSite: "Lax" }]);
      }
    }
    await login(page.request, users[0].email);
    const other = await playwright.request.newContext({ baseURL });
    contexts.push(other);
    await login(other, users[1].email);
    async function place(request: APIRequestContext, outcome: "YES" | "NO", price: string) {
      // The actual order endpoint invokes placeOrder and its matching/accounting engine.
      const response = await request.post("/api/v1/orders", {
        headers: { Origin: baseURL!, "Idempotency-Key": randomUUID(), Cookie: sessionCookies.get(request)! },
        data: { marketSlug: market.slug, clientOrderId: randomUUID(), outcome, action: "BUY", limitPriceMilli: price, quantity: 1 },
      });
      expect(response.status(), await response.text()).toBe(201);
    }
    for (let index = 0; index < 21; index += 1) await place(page.request, "NO", "10000");
    await place(page.request, "NO", "38000");
    await place(other, "YES", "62000");
    const fillResponse = await page.request.get(`/api/v1/fills?marketSlug=${market.slug}`);
    expect(fillResponse.ok()).toBeTruthy();
    const { fills } = await fillResponse.json() as { fills: { outcome: string; executionPriceMilli: string; feeMilli: string; role: string }[] };
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ outcome: "NO", executionPriceMilli: "38000", role: "MAKER" });
    expect(BigInt(fills[0].feeMilli)).toBeGreaterThan(0n);

    await page.goto("/portfolio");
    await expect(page.getByRole("heading", { name: "Your positions", exact: true })).toBeVisible();
    const position = page.locator(".position-row");
    await expect(position).toHaveCount(1);
    await expect(position).toHaveAttribute("href", `/markets/${market.slug}?outcome=NO`);
    await expect(position).toContainText("Open");
    await mkdir("output/playwright/portfolio-activity", { recursive: true });
    await page.screenshot({ path: `output/playwright/portfolio-activity/positions-${testInfo.project.name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const views = page.getByRole("navigation", { name: "Portfolio views" });
    await views.getByRole("link", { name: "History", exact: true }).click();
    await expect(page.getByRole("list", { name: "Trade history" })).toContainText("Bought 1 contract");
    await views.getByRole("link", { name: "Orders", exact: true }).click();
    await expect(page.getByLabel("Order status")).toHaveValue("open");
    await expect(page.getByRole("region", { name: "Order history" }).getByRole("listitem")).toHaveCount(20);
    await place(page.request, "NO", "12000");
    await expect(page.getByRole("region", { name: "Order history" }).getByRole("listitem").first()).toContainText("12 feathers", { timeout: 25_000 });
    await page.screenshot({ path: `output/playwright/portfolio-activity/open-orders-${testInfo.project.name}.png`, fullPage: false });
    // Existing deep links keep the detailed orders/fills view.
    await page.goto("/portfolio/activity");
    const orders = page.getByRole("region", { name: "Order history" });
    await expect(orders.getByRole("listitem")).toHaveCount(20);
    const cards = orders.getByRole("listitem");
    const filled = cards.filter({ hasText: "38 feathers" });
    await expect(filled).toHaveCount(1);
    await expect(fact(filled, "Limit price")).toHaveText("38 feathers");
    await expect(fact(filled, "Filled / remaining")).toHaveText("1 / 0");
    await expect(fact(cards.filter({ hasText: "10 feathers" }).first(), "Limit price")).toHaveText("10 feathers");
    await orders.getByRole("button", { name: "Load more" }).click();
    await expect(cards).toHaveCount(23);
    await expect(orders.getByRole("button", { name: "Load more" })).toHaveCount(0);

    await mkdir("output/playwright/portfolio-activity", { recursive: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/portfolio-activity/orders-${testInfo.project.name}.png`, fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const refreshed = page.waitForResponse(response => response.url().includes("/api/v1/orders?limit=20"));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    expect((await refreshed).ok()).toBeTruthy();
    await expect(cards).toHaveCount(20);
    await page.route("**/api/v1/fills?**", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "Temporary test failure" } }) }));
    await page.getByRole("button", { name: "Fills", exact: true }).click();
    const history = page.getByRole("region", { name: "Fill history" });
    await expect(history.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    await page.unroute("**/api/v1/fills?**");
    await history.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(history.getByRole("listitem")).toHaveCount(1);
    const fill = history.getByRole("listitem");
    await expect(fact(fill, "Fill price")).toHaveText("38 feathers");
    await expect(fact(fill, "Quantity")).toHaveText("1 contract");
    await expect(history.getByRole("status")).toHaveText("1 fill shown");
    await expect(fact(fill, "Your role")).toHaveText("maker");
    await expect(fact(fill, "Your fee")).toHaveText(feathers(fills[0].feeMilli));
    for (const privateValue of [users[1].email, users[1].username, "clientOrderId", "tradeSequence"]) {
      await expect(history).not.toContainText(privateValue);
    }
    await page.screenshot({ path: `output/playwright/portfolio-activity/fills-${testInfo.project.name}.png`, fullPage: false });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: `output/playwright/portfolio-activity/fills-dark-${testInfo.project.name}.png`, fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.context().clearCookies();
    await login(page.request, users[2].email);
    await page.goto("/portfolio/activity");
    await expect(page.getByRole("heading", { name: "No orders yet" })).toBeVisible();
    await page.getByRole("button", { name: "Fills", exact: true }).click();
    await expect(page.getByRole("heading", { name: "No fills yet" })).toBeVisible();
    await page.screenshot({ path: `output/playwright/portfolio-activity/empty-${testInfo.project.name}.png`, fullPage: false });
  } finally {
    await Promise.all(contexts.map(context => context.dispose()));
    await db.$disconnect();
  }
});
