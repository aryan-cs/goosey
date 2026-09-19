import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

function isolatedDatabaseOnly(baseURL: string | undefined) {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !baseURL || !/^http:\/\/127\.0\.0\.1:808[1-3]$/u.test(baseURL) ||
    process.env.DATABASE_PROVIDER === "postgresql" ||
    !databaseUrl?.startsWith("file:") ||
    /dev\.db(?:$|[?#])/u.test(databaseUrl)
  ) {
    throw new Error("Event navigation fixtures require a disposable SQLite database on loopback port 8081, 8082, or 8083.");
  }
}

async function readJson(response: { status(): number; text(): Promise<string>; url(): string }) {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url()}, received: ${text.slice(0, 500)}`);
  }
  return { status: response.status(), body };
}

test("public events preserve group navigation, forecasts, filtering, and paging", async ({ page, playwright, baseURL }) => {
  isolatedDatabaseOnly(baseURL);
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
  const suffix = randomUUID().replaceAll("-", "");
  const token = `Nav${suffix.slice(0, 10)}`;
  const pagingToken = `Page${suffix.slice(10, 20)}`;
  const coreCategory = `Navigation ${suffix.slice(0, 8)}`;
  const pagingCategory = `Paging ${suffix.slice(8, 16)}`;
  const password = "Goosey-event-navigation-2026!";
  const contexts: APIRequestContext[] = [];
  const now = Date.now();

  try {
    expect(await db.user.count({ where: { role: "SYSTEM", status: "ACTIVE" } }), "The isolated database must be initialized with the SYSTEM principal.").toBeGreaterThan(0);
    const admin = await db.user.create({
      data: {
        email: `event-nav-admin-${suffix}@goosey.test`,
        username: `ena_${suffix.slice(0, 18)}`,
        displayName: "Event navigation admin",
        passwordHash: await hash(password, 4),
        emailVerifiedAt: new Date(),
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const loginApi = await playwright.request.newContext({ baseURL });
    contexts.push(loginApi);
    const login = await loginApi.post("/api/auth/login", {
      headers: { Origin: baseURL! },
      data: { email: admin.email, password },
    });
    const loginText = await login.text();
    expect(login.status(), loginText).toBe(200);
    // Production emits a Secure session cookie, so Playwright correctly will
    // not resend it over the guarded loopback HTTP server. Carry the exact
    // returned cookie into the isolated admin API context explicitly.
    const sessionCookie = login.headers()["set-cookie"]?.split(";", 1)[0];
    expect(sessionCookie).toMatch(/^goosey_session=.+/u);
    const adminApi = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: sessionCookie! },
    });
    contexts.push(adminApi);

    type CreatedEvent = { id: string; slug: string; title: string; shortTitle: string };
    type CreatedMarket = { id: string; slug: string; shortTitle: string };

    async function createEvent(input: {
      slug: string;
      title: string;
      shortTitle: string;
      category?: string;
      startsAt: Date;
      endsAt: Date;
    }): Promise<CreatedEvent> {
      const response = await adminApi.post("/api/admin/events", {
        headers: { Origin: baseURL!, "Idempotency-Key": randomUUID() },
        data: {
          slug: input.slug,
          title: input.title,
          shortTitle: input.shortTitle,
          description: `A real isolated event fixture for ${input.title}.`,
          category: input.category ?? coreCategory,
          featured: false,
          color: "blue",
          icon: "calendar-days",
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        },
      });
      const result = await readJson(response);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      return (result.body as { event: CreatedEvent }).event;
    }

    async function createMarket(input: {
      eventId: string;
      slug: string;
      title: string;
      shortTitle: string;
      status?: "OPEN" | "DRAFT";
    }): Promise<CreatedMarket> {
      const response = await adminApi.post("/api/admin/markets", {
        headers: { Origin: baseURL!, "Idempotency-Key": randomUUID() },
        data: {
          eventId: input.eventId,
          slug: input.slug,
          title: input.title,
          shortTitle: input.shortTitle,
          description: `A real zero-subsidy order-book fixture for ${input.title}.`,
          rules: "This market exists only inside the isolated event navigation browser test.",
          resolutionSource: "Automated browser regression",
          category: coreCategory,
          status: input.status ?? "OPEN",
          featured: false,
          color: "blue",
          icon: "calendar-days",
          pricingModel: "ORDER_BOOK",
          payoutMilli: "100000",
          feeBps: 0,
          closesAt: new Date(now + 7 * 24 * 60 * 60 * 1_000).toISOString(),
          resolvesAt: new Date(now + 8 * 24 * 60 * 60 * 1_000).toISOString(),
        },
      });
      const result = await readJson(response);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      expect((result.body as { subsidyMilli: string }).subsidyMilli).toBe("0");
      const created = (result.body as { market: { id: string } }).market;
      return db.market.findUniqueOrThrow({ where: { id: created.id }, select: { id: true, slug: true, shortTitle: true } });
    }

    const liveEvent = await createEvent({
      slug: `event-live-${suffix}`,
      title: `${token} Live Build Weekend`,
      shortTitle: `${token} Live`,
      startsAt: new Date(now - 60 * 60 * 1_000),
      endsAt: new Date(now + 24 * 60 * 60 * 1_000),
    });
    const upcomingEvent = await createEvent({
      slug: `event-upcoming-${suffix}`,
      title: `${token} Upcoming Demo Day`,
      shortTitle: `${token} Upcoming`,
      startsAt: new Date(now + 2 * 24 * 60 * 60 * 1_000),
      endsAt: new Date(now + 3 * 24 * 60 * 60 * 1_000),
    });
    const pastEvent = await createEvent({
      slug: `event-past-${suffix}`,
      title: `${token} Past Kickoff`,
      shortTitle: `${token} Past`,
      startsAt: new Date(now - 3 * 24 * 60 * 60 * 1_000),
      endsAt: new Date(now - 2 * 24 * 60 * 60 * 1_000),
    });
    const draftOnlyEvent = await createEvent({
      slug: `event-draft-${suffix}`,
      title: `${token} Draft Only`,
      shortTitle: `${token} Draft`,
      startsAt: new Date(now - 60 * 60 * 1_000),
      endsAt: new Date(now + 24 * 60 * 60 * 1_000),
    });

    const noPriceMarket = await createMarket({
      eventId: liveEvent.id,
      slug: `event-no-price-${suffix}`,
      title: `${token} market without order-book depth`,
      shortTitle: `${token} No price`,
    });
    const resolvedYesMarket = await createMarket({
      eventId: liveEvent.id,
      slug: `event-resolved-yes-${suffix}`,
      title: `${token} market resolved yes`,
      shortTitle: `${token} Resolved YES`,
    });
    const resolvedNoMarket = await createMarket({
      eventId: liveEvent.id,
      slug: `event-resolved-no-${suffix}`,
      title: `${token} market resolved no`,
      shortTitle: `${token} Resolved NO`,
    });
    const hiddenDraftMarket = await createMarket({
      eventId: liveEvent.id,
      slug: `event-hidden-draft-${suffix}`,
      title: `${token} hidden draft market`,
      shortTitle: `${token} Hidden draft`,
      status: "DRAFT",
    });
    const upcomingMarket = await createMarket({
      eventId: upcomingEvent.id,
      slug: `event-upcoming-market-${suffix}`,
      title: `${token} upcoming event market`,
      shortTitle: `${token} Upcoming market`,
    });
    const pastMarket = await createMarket({
      eventId: pastEvent.id,
      slug: `event-past-market-${suffix}`,
      title: `${token} past event market`,
      shortTitle: `${token} Past market`,
    });
    await createMarket({
      eventId: draftOnlyEvent.id,
      slug: `event-draft-market-${suffix}`,
      title: `${token} draft-only event market`,
      shortTitle: `${token} Draft-only market`,
      status: "DRAFT",
    });

    await db.$transaction([
      db.market.update({
        where: { id: resolvedYesMarket.id },
        data: { status: "RESOLVED", resolution: "YES", acceptingOrders: false, resolvedAt: new Date(now - 5 * 60_000) },
      }),
      db.market.update({
        where: { id: resolvedNoMarket.id },
        data: { status: "RESOLVED", resolution: "NO", acceptingOrders: false, resolvedAt: new Date(now - 4 * 60_000) },
      }),
      db.market.update({
        where: { id: pastMarket.id },
        data: { status: "CLOSED", acceptingOrders: false },
      }),
    ]);
    expect(await db.marketPriceSnapshot.count({
      where: { marketId: { in: [noPriceMarket.id, resolvedYesMarket.id, resolvedNoMarket.id, upcomingMarket.id, pastMarket.id] } },
    })).toBe(0);

    // Paging data is deliberately created at the persistence boundary: each
    // event owns a real, empty, zero-collateral CLOB and no synthetic mark.
    const pagingEvents: Array<{ slug: string; shortTitle: string }> = [];
    for (let index = 0; index < 13; index += 1) {
      const ordinal = (index + 1).toString().padStart(2, "0");
      const eventSlug = `event-page-${suffix}-${ordinal}`;
      const marketSlug = `event-page-market-${suffix}-${ordinal}`;
      const event = await db.$transaction(async (tx) => {
        const createdEvent = await tx.marketEvent.create({
          data: {
            slug: eventSlug,
            title: `${pagingToken} Paging Event ${ordinal}`,
            shortTitle: `${pagingToken} Page ${ordinal}`,
            description: `A real isolated pagination fixture for event ${ordinal}.`,
            category: pagingCategory,
            featured: false,
            color: "sky",
            icon: "calendar-days",
            startsAt: new Date(now + (index + 10) * 60 * 60 * 1_000),
            endsAt: new Date(now + (index + 34) * 60 * 60 * 1_000),
            createdById: admin.id,
          },
        });
        const collateral = await tx.ledgerAccount.create({
          data: { ownerType: "MARKET", ownerId: marketSlug, purpose: "COLLATERAL", balanceMilli: 0n },
        });
        const market = await tx.market.create({
          data: {
            slug: marketSlug,
            title: `${pagingToken} paging market ${ordinal}`,
            shortTitle: `${pagingToken} Paging market ${ordinal}`,
            description: `A real empty order book for pagination event ${ordinal}.`,
            rules: "This market exists only inside the isolated event navigation browser test.",
            resolutionSource: "Automated browser regression",
            category: pagingCategory,
            pricingModel: "ORDER_BOOK",
            status: "OPEN",
            feeBps: 0,
            payoutMilli: 100_000n,
            closesAt: new Date(now + 7 * 24 * 60 * 60 * 1_000),
            resolvesAt: new Date(now + 8 * 24 * 60 * 60 * 1_000),
            createdById: admin.id,
            eventId: createdEvent.id,
            collateralAccountId: collateral.id,
          },
        });
        await tx.ledgerAccount.update({ where: { id: collateral.id }, data: { ownerId: market.id } });
        return createdEvent;
      });
      pagingEvents.push({ slug: event.slug, shortTitle: event.shortTitle });
    }

    await test.step("search links same-category events to their distinct event groups", async () => {
      await page.goto("/search");
      await page.getByRole("searchbox", { name: "Search Goosey" }).fill(token);
      await expect(page.getByRole("heading", { name: "Events" })).toBeVisible();
      const liveLink = page.locator(`a[href="/events/${liveEvent.slug}"]`);
      const upcomingLink = page.locator(`a[href="/events/${upcomingEvent.slug}"]`);
      await expect(liveLink).toContainText(liveEvent.shortTitle);
      await expect(upcomingLink).toContainText(upcomingEvent.shortTitle);
      await liveLink.click();
      await expect(page).toHaveURL(new RegExp(`/events/${liveEvent.slug}$`));
      await expect(page.getByRole("heading", { name: liveEvent.title })).toBeVisible();
    });

    await test.step("event detail exposes only public member markets and honest marks", async () => {
      await expect(page.getByRole("link", { name: "Events", exact: true })).toBeVisible();
      await expect(page.locator(`a[href="/markets/${noPriceMarket.slug}"]`)).toContainText(noPriceMarket.shortTitle);
      await expect(page.locator(`a[href="/markets/${resolvedYesMarket.slug}"]`)).toContainText(resolvedYesMarket.shortTitle);
      await expect(page.locator(`a[href="/markets/${resolvedNoMarket.slug}"]`)).toContainText(resolvedNoMarket.shortTitle);
      await expect(page.locator(`a[href="/markets/${hiddenDraftMarket.slug}"]`)).toHaveCount(0);
      await expect(page.getByText("No price yet", { exact: true })).toBeVisible();
      await expect(page.getByText("100%", { exact: true })).toBeVisible();
      await expect(page.getByText("0%", { exact: true })).toBeVisible();
      await expect(page.getByText(/independent contracts/i)).toBeVisible();

      // Next streams the layout with HTTP 200 before an async notFound().
      // Assert the rendered boundary and the non-streamed API's true 404.
      for (const slug of [draftOnlyEvent.slug, `unknown-${suffix}`]) {
        await page.goto(`/events/${slug}`);
        await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
        await expect(page.locator('meta[name="robots"][content="noindex"]').first()).toBeAttached();
        expect((await page.request.get(`/api/events/${slug}`)).status()).toBe(404);
      }
    });

    await test.step("event index applies strict timing and category filters", async () => {
      await page.goto("/events");
      await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
      const timing = page.getByLabel("Event timing");
      const category = page.getByLabel("Category");
      expect(await timing.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
        .toEqual(["all", "live", "upcoming", "past"]);
      await category.selectOption({ label: coreCategory });
      await timing.selectOption("live");
      await page.getByRole("button", { name: "Show events" }).click();
      await expect(page.locator(`a[href="/events/${liveEvent.slug}"]`)).toBeVisible();
      await expect(page.locator(`a[href="/events/${upcomingEvent.slug}"]`)).toHaveCount(0);
      await expect(page.locator(`a[href="/events/${pastEvent.slug}"]`)).toHaveCount(0);
      await expect(page.locator(`a[href="/events/${draftOnlyEvent.slug}"]`)).toHaveCount(0);

      await timing.selectOption("upcoming");
      await page.getByRole("button", { name: "Show events" }).click();
      await expect(page.locator(`a[href="/events/${upcomingEvent.slug}"]`)).toBeVisible();
      await expect(page.locator(`a[href="/events/${liveEvent.slug}"]`)).toHaveCount(0);

      await timing.selectOption("past");
      await page.getByRole("button", { name: "Show events" }).click();
      await expect(page.locator(`a[href="/events/${pastEvent.slug}"]`)).toBeVisible();
      await expect(page.locator(`a[href="/events/${liveEvent.slug}"]`)).toHaveCount(0);

      await page.goto("/events?timing=tomorrow&unexpected=value");
      await expect(page.getByRole("heading", { name: "Invalid event filters" })).toBeVisible();
    });

    await test.step("event index exposes exactly twelve fixtures before the older page", async () => {
      await page.goto("/events");
      await page.getByLabel("Category").selectOption({ label: pagingCategory });
      await page.getByLabel("Event timing").selectOption("all");
      await page.getByRole("button", { name: "Show events" }).click();
      const pageLinks = page.locator(`a[href^="/events/event-page-${suffix}-"]`);
      await expect(pageLinks).toHaveCount(12);
      await expect(page.locator(`a[href="/events/${pagingEvents[0].slug}"]`)).toContainText(pagingEvents[0].shortTitle);
      await expect(page.locator(`a[href="/events/${pagingEvents[12].slug}"]`)).toHaveCount(0);
      await page.getByRole("link", { name: "More events" }).click();
      await expect(page.locator(`a[href="/events/${pagingEvents[12].slug}"]`)).toContainText(pagingEvents[12].shortTitle);
    });
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
    await db.$disconnect();
  }
});
