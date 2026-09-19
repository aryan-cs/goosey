import { requireDatabaseFinancialMarket } from "../../src/lib/market-backend";
import { randomUUID } from "node:crypto";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { grantWelcomeFeathers } from "../../src/lib/auth";

function isolatedDatabaseOnly(baseURL: string | undefined) {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    baseURL !== "http://127.0.0.1:8081" ||
    process.env.DATABASE_PROVIDER === "postgresql" ||
    !databaseUrl?.startsWith("file:") ||
    /(?:^|\/)dev\.db(?:$|[?#])/u.test(databaseUrl)
  ) {
    throw new Error("Advanced-order browser fixtures require a disposable SQLite database and http://127.0.0.1:8081.");
  }
}

async function responseJson(response: { text(): Promise<string>; status(): number; url(): string }) {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url()}, received: ${text.slice(0, 500)}`);
  }
  return { status: response.status(), body };
}

type OrderResponse = {
  accepted: true;
  order: {
    orderId: string;
    status: string;
    filledQuantity: number;
    remainingQuantity: number;
    canceledQuantity: number;
    postOnly: boolean;
    expiresAt: string | null;
  };
  fills: unknown[];
};

async function submitOrder(page: Page): Promise<{ status: number; body: OrderResponse | { accepted: false; reason: string } }> {
  const pending = page.waitForResponse((response) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/orders");
  await page.getByRole("button", { name: "Place limit order" }).click();
  return responseJson(await pending) as Promise<{ status: number; body: OrderResponse | { accepted: false; reason: string } }>;
}

test("advanced order controls preserve IOC, FOK, post-only, expiration, and retry semantics", async ({ page, playwright, baseURL }) => {
  isolatedDatabaseOnly(baseURL);
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL! });
  const suffix = randomUUID();
  const password = "Goosey-order-options-2026!";
  const contexts: APIRequestContext[] = [];

  try {
    expect(await db.user.count({ where: { role: "SYSTEM", status: "ACTIVE" } }), "The isolated database must be initialized with the SYSTEM principal.").toBeGreaterThan(0);
    const passwordHash = await hash(password, 4);
    const admin = await db.user.create({
      data: {
        email: `options-admin-${suffix}@goosey.test`,
        username: `oa_${suffix.replaceAll("-", "").slice(0, 18)}`,
        displayName: "Order options admin",
        passwordHash,
        emailVerifiedAt: new Date(),
        role: "ADMIN",
        status: "ACTIVE",
      },
    });
    const users = [];
    for (const role of ["primary", "counterparty"] as const) {
      const user = await db.user.create({
        data: {
          email: `options-${role}-${suffix}@goosey.test`,
          username: `o${role[0]}_${suffix.replaceAll("-", "").slice(0, 18)}`,
          displayName: `Order options ${role}`,
          passwordHash,
          emailVerifiedAt: new Date(),
          role: "USER",
          status: "ACTIVE",
        },
      });
      const granted = await db.$transaction((tx) => grantWelcomeFeathers(tx, user.id));
      expect(granted, `Expected a real welcome-grant journal for ${role}.`).toBe(true);
      users.push(user);
    }
    const [primary, counterparty] = users;
    const now = Date.now();
    const marketInput = {
      slug: `order-options-${suffix}`,
      title: "Will the advanced order controls preserve exchange semantics?",
      shortTitle: "Advanced order controls",
      description: "A private disposable market for real browser regressions of advanced order controls.",
      rules: "This market exists only inside the isolated browser test database.",
      resolutionSource: "Automated browser regression",
      category: "Tests",
      status: "OPEN",
      featured: false,
      pricingModel: "ORDER_BOOK",
      payoutMilli: "100000",
      feeBps: 0,
      closesAt: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
      resolvesAt: new Date(now + 48 * 60 * 60 * 1_000).toISOString(),
    };
    const adminRequest = await playwright.request.newContext({ baseURL });
    contexts.push(adminRequest);
    const adminCookie = await login(adminRequest, admin.email);
    const marketResponse = await adminRequest.post("/api/admin/markets", {
      headers: { Origin: baseURL!, Cookie: adminCookie, "Idempotency-Key": randomUUID() }, data: marketInput,
    });
    const marketResult = await responseJson(marketResponse);
    expect(marketResult.status).toBe(201);
    const created = marketResult.body as { market: { id: string }; subsidyMilli: string };
    const market = await db.market.findUniqueOrThrow({ where: { id: created.market.id } });
    expect(created.subsidyMilli).toBe("0");
    expect(await db.marketPriceSnapshot.count({ where: { marketId: market.id } })).toBe(0);

    async function login(request: APIRequestContext, email: string, attachToPage = false) {
      const response = await request.post("/api/auth/login", { headers: { Origin: baseURL! }, data: { email, password } });
      const text = await response.text();
      expect(response.status(), text).toBe(200);
      const cookie = response.headers()["set-cookie"].split(";")[0];
      if (attachToPage) {
        const separator = cookie.indexOf("=");
        await page.context().addCookies([{
          name: cookie.slice(0, separator),
          value: cookie.slice(separator + 1),
          url: baseURL!,
          secure: false,
          httpOnly: true,
          sameSite: "Lax",
        }]);
      }
      // This disposable production build is served over loopback HTTP. API
      // contexts correctly withhold Secure cookies, so pass the test cookie
      // explicitly rather than weakening production cookie configuration.
      return cookie;
    }

    await login(page.request, primary.email, true);
    const counter = await playwright.request.newContext({ baseURL });
    contexts.push(counter);
    const counterCookie = await login(counter, counterparty.email);

    async function placeCounter(quantity: number) {
      const response = await counter.post("/api/v1/orders", {
        headers: { Origin: baseURL!, Cookie: counterCookie, "Idempotency-Key": randomUUID() },
        data: {
          marketSlug: market.slug,
          clientOrderId: randomUUID(),
          outcome: "NO",
          action: "BUY",
          limitPriceMilli: "60000",
          quantity,
          timeInForce: "GTC",
          postOnly: false,
          selfTradePrevention: "CANCEL_AGGRESSOR",
          expiresAt: null,
          cancelOnPause: true,
          reduceOnly: false,
        },
      });
      const result = await responseJson(response);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      return result.body as OrderResponse;
    }

    async function economicSnapshot() {
      const [user, wallet, collateral, position, fills] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { id: primary.id }, select: { balanceMilli: true } }),
        db.ledgerAccount.findUniqueOrThrow({
          where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: primary.id, purpose: "USER_FEATHERS" } },
          select: { balanceMilli: true },
        }),
        db.ledgerAccount.findUniqueOrThrow({ where: { id: requireDatabaseFinancialMarket(market).collateralAccountId }, select: { balanceMilli: true } }),
        db.position.findUnique({
          where: { userId_marketId: { userId: primary.id, marketId: market.id } },
          select: { yesShares: true, noShares: true, yesCostBasisMilli: true, noCostBasisMilli: true, netCostMilli: true },
        }),
        db.orderFill.count({ where: { marketId: market.id } }),
      ]);
      return { cachedBalance: user.balanceMilli, wallet: wallet.balanceMilli, collateral: collateral.balanceMilli, position, fills };
    }

    async function structuralSnapshot() {
      const [economic, orders, reservations] = await Promise.all([
        economicSnapshot(),
        db.marketOrder.count({ where: { marketId: market.id } }),
        db.orderReservation.count({ where: { marketId: market.id } }),
      ]);
      return { economic, orders, reservations };
    }

    async function expectNoActivePrimaryReserve() {
      const reservations = await db.orderReservation.findMany({
        where: { marketId: market.id, userId: primary.id },
        select: { reservedPrincipalMilli: true, reservedFeeMilli: true, reservedYesQuantity: true, reservedNoQuantity: true },
      });
      expect(reservations.reduce((sum, row) => sum + row.reservedPrincipalMilli + row.reservedFeeMilli, 0n)).toBe(0n);
      expect(reservations.reduce((sum, row) => sum + row.reservedYesQuantity + row.reservedNoQuantity, 0)).toBe(0);
    }

    await page.goto(`/markets/${market.slug}`);
    await page.getByRole("button", { name: "Buy", exact: true }).click();
    await page.getByRole("button", { name: "Yes", exact: true }).click();
    await page.getByText("Advanced order options", { exact: true }).click();
    const duration = page.getByLabel("Order duration");
    const postOnly = page.getByRole("checkbox", { name: "Post-only (rest on the book)" });
    const expiration = page.getByLabel("Expiration (your local time)");
    const price = page.getByLabel(/Limit price/);
    const quantity = page.getByLabel("Contracts");

    // An IOC against an empty book commits a terminal order but no fill or reserve.
    await duration.selectOption("IOC");
    await price.fill("40");
    await quantity.fill("2");
    const emptyIocBefore = await economicSnapshot();
    const emptyIoc = await submitOrder(page);
    expect(emptyIoc.status).toBe(201);
    expect(emptyIoc.body).toMatchObject({
      accepted: true,
      order: { status: "CANCELED", filledQuantity: 0, canceledQuantity: 2, remainingQuantity: 0 },
      fills: [],
    });
    expect(await economicSnapshot()).toEqual(emptyIocBefore);
    await expectNoActivePrimaryReserve();
    await expect(page.getByRole("status").filter({ hasText: "Order canceled without any fills" })).toBeVisible();

    // IOC consumes available depth exactly once and cancels only the remainder.
    await placeCounter(1);
    const partialIoc = await submitOrder(page);
    expect(partialIoc.status).toBe(201);
    expect(partialIoc.body).toMatchObject({
      accepted: true,
      order: { status: "CANCELED", filledQuantity: 1, canceledQuantity: 1, remainingQuantity: 0 },
    });
    expect((partialIoc.body as OrderResponse).fills).toHaveLength(1);
    await expectNoActivePrimaryReserve();
    await expect(page.getByRole("status").filter({ hasText: "1 contract filled. 1 contract canceled" })).toBeVisible();

    // A rejected FOK has no order/economic footprint. Retrying the unchanged
    // draft after liquidity arrives creates a new idempotency envelope.
    await duration.selectOption("FOK");
    const fokBefore = await structuralSnapshot();
    const firstFokRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/orders");
    const rejectedFok = await submitOrder(page);
    const firstFok = await firstFokRequest;
    expect(rejectedFok.status).toBe(422);
    expect(rejectedFok.body).toMatchObject({ accepted: false, reason: "FOK_NOT_FILLABLE" });
    expect(await structuralSnapshot()).toEqual(fokBefore);
    await expect(page.locator("#order-book").getByRole("alert")).toContainText("Fill-or-kill order rejected");
    const unchangedDraft = { price: await price.inputValue(), quantity: await quantity.inputValue(), duration: await duration.inputValue() };
    await placeCounter(2);
    const secondFokRequest = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/orders");
    const acceptedFok = await submitOrder(page);
    const secondFok = await secondFokRequest;
    expect({ price: await price.inputValue(), quantity: await quantity.inputValue(), duration: await duration.inputValue() }).toEqual(unchangedDraft);
    expect(secondFok.headers()["idempotency-key"]).not.toBe(firstFok.headers()["idempotency-key"]);
    const firstFokBody = firstFok.postDataJSON() as Record<string, unknown>;
    const secondFokBody = secondFok.postDataJSON() as Record<string, unknown>;
    expect({ ...secondFokBody, clientOrderId: firstFokBody.clientOrderId }).toEqual(firstFokBody);
    expect(acceptedFok.status).toBe(201);
    expect(acceptedFok.body).toMatchObject({ accepted: true, order: { status: "FILLED", filledQuantity: 2, remainingQuantity: 0 } });

    // Post-only crossing rejects atomically; a non-crossing edit rests normally.
    const restingCounter = await placeCounter(1);
    await duration.selectOption("GTC");
    await postOnly.check();
    await price.fill("40");
    await quantity.fill("1");
    const crossingBefore = await structuralSnapshot();
    const crossing = await submitOrder(page);
    expect(crossing.status).toBe(422);
    expect(crossing.body).toMatchObject({ accepted: false, reason: "POST_ONLY_WOULD_TRADE" });
    expect(await structuralSnapshot()).toEqual(crossingBefore);
    await expect(page.locator("#order-book").getByRole("alert")).toContainText("Post-only order rejected");
    await price.fill("30");
    const resting = await submitOrder(page);
    expect(resting.status).toBe(201);
    expect(resting.body).toMatchObject({ accepted: true, order: { status: "OPEN", remainingQuantity: 1, postOnly: true } });

    // Leaving GTC clears and disables controls that the backend forbids on IOC/FOK.
    const futureLocal = new Date(Date.now() + 60 * 60 * 1_000);
    futureLocal.setSeconds(0, 0);
    const localValue = `${futureLocal.getFullYear().toString().padStart(4, "0")}-${(futureLocal.getMonth() + 1).toString().padStart(2, "0")}-${futureLocal.getDate().toString().padStart(2, "0")}T${futureLocal.getHours().toString().padStart(2, "0")}:${futureLocal.getMinutes().toString().padStart(2, "0")}`;
    await expiration.fill(localValue);
    expect(await postOnly.isChecked()).toBe(true);
    await duration.selectOption("IOC");
    await expect(postOnly).toBeDisabled();
    await expect(postOnly).not.toBeChecked();
    await expect(expiration).toBeDisabled();
    await expect(expiration).toHaveValue("");

    // If the server commits an expiring GTC order but its response is lost, the
    // UI retries the exact body and idempotency key; only one order persists.
    await duration.selectOption("GTC");
    await expiration.fill(localValue);
    await price.fill("20");
    await quantity.fill("1");
    const attempts: Array<{ key: string | undefined; body: string | null }> = [];
    let intercepted = 0;
    await page.route("**/api/v1/orders", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      intercepted += 1;
      attempts.push({ key: route.request().headers()["idempotency-key"], body: route.request().postData() });
      const response = await route.fetch();
      if (intercepted === 1) {
        expect(response.status()).toBe(201);
        await route.abort("failed");
      } else {
        await route.fulfill({ response });
      }
    });
    await page.getByRole("button", { name: "Place limit order" }).click();
    await expect(page.locator("#order-book").getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Place limit order" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Limit order placed" })).toBeVisible();
    await page.unroute("**/api/v1/orders");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const retryBody = JSON.parse(attempts[0].body!) as { clientOrderId: string; expiresAt: string; timeInForce: string };
    expect(retryBody.timeInForce).toBe("GTC");
    expect(new Date(retryBody.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const persisted = await db.marketOrder.findMany({ where: { userId: primary.id, clientOrderId: retryBody.clientOrderId } });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].expiresAt?.toISOString()).toBe(retryBody.expiresAt);
    expect(persisted[0]).toMatchObject({ marketId: market.id, status: "OPEN", timeInForce: "GTC", remainingQuantity: 1 });

    // A confirmed post-only amendment rejection must allow the unchanged draft
    // to try current liquidity with a new command, preserving the original.
    const originalId = (resting.body as OrderResponse).order.orderId;
    const originalBefore = await db.marketOrder.findUniqueOrThrow({ where: { id: originalId } });
    const postOnlyRow = page.locator(".open-order-list > div").filter({ hasText: "30.000" });
    await postOnlyRow.getByRole("button", { name: "Edit remaining order" }).click();
    const editor = page.getByRole("form", { name: "Edit BUY YES remaining order" });
    await editor.getByLabel("YES limit price (feathers)").fill("40");
    const replacementBefore = await structuralSnapshot();
    const patchPath = `/api/v1/orders/${originalId}`;
    const rejectedPatchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === patchPath);
    await editor.getByRole("button", { name: "Save replacement" }).click();
    const rejectedPatch = await rejectedPatchResponse;
    expect(await responseJson(rejectedPatch)).toMatchObject({
      status: 422, body: { accepted: false, reason: "POST_ONLY_WOULD_TRADE" },
    });
    await expect(editor.getByRole("alert")).toContainText("The original order was preserved");
    expect(await structuralSnapshot()).toEqual(replacementBefore);
    expect(await db.marketOrder.findUniqueOrThrow({ where: { id: originalId } })).toEqual(originalBefore);
    const rejectedRequest = rejectedPatch.request();
    const draft = {
      price: await editor.getByLabel("YES limit price (feathers)").inputValue(),
      quantity: await editor.getByLabel("Remaining contracts").inputValue(),
    };

    const counterOrder = await db.marketOrder.findUniqueOrThrow({ where: { id: restingCounter.order.orderId } });
    const canceledCounter = await counter.delete(`/api/v1/orders/${counterOrder.id}`, {
      headers: {
        Origin: baseURL!, Cookie: counterCookie, "Idempotency-Key": randomUUID(),
        "If-Match": `order-version-${counterOrder.version}`,
      },
    });
    expect(canceledCounter.status(), await canceledCounter.text()).toBe(200);
    expect(await db.marketOrder.findUniqueOrThrow({ where: { id: counterOrder.id } })).toMatchObject({ status: "CANCELED", remainingQuantity: 0 });
    const acceptedPatchResponse = page.waitForResponse((response) =>
      response.request().method() === "PATCH" && new URL(response.url()).pathname === patchPath);
    await editor.getByRole("button", { name: "Save replacement" }).click();
    const acceptedPatch = await acceptedPatchResponse;
    const acceptedReplacement = await responseJson(acceptedPatch);
    expect(acceptedReplacement).toMatchObject({ status: 200, body: {
      accepted: true, replacedOrderId: originalId,
      order: { status: "OPEN", postOnly: true, remainingQuantity: 1 },
    } });
    const acceptedRequest = acceptedPatch.request();
    expect(acceptedRequest.headers()["idempotency-key"]).toBeTruthy();
    expect(acceptedRequest.headers()["idempotency-key"]).not.toBe(rejectedRequest.headers()["idempotency-key"]);
    const rejectedBody = rejectedRequest.postDataJSON();
    const acceptedBody = acceptedRequest.postDataJSON();
    expect(acceptedBody.clientOrderId).not.toBe(rejectedBody.clientOrderId);
    expect({ ...acceptedBody, clientOrderId: rejectedBody.clientOrderId }).toEqual(rejectedBody);
    expect(acceptedBody).toMatchObject({ limitPriceMilli: String(Number(draft.price) * 1_000), quantity: Number(draft.quantity) });
    expect(acceptedRequest.headers()["if-match"]).toBe(rejectedRequest.headers()["if-match"]);
    await expect(editor).not.toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Remaining order replaced" })).toBeVisible();

    // Lose the response only after the real PATCH committed. The unchanged
    // retry must replay its exact body, key and version, not replace twice.
    const replacementId = (acceptedReplacement.body as OrderResponse).order.orderId;
    await page.locator(".open-order-list > div").filter({ hasText: "40.000" })
      .getByRole("button", { name: "Edit remaining order" }).click();
    await editor.getByLabel("YES limit price (feathers)").fill("35");
    const patchAttempts: Array<{ key: string | undefined; version: string | undefined; body: string | null }> = [];
    let committedBody: unknown;
    const replacementUrl = `**/api/v1/orders/${replacementId}`;
    await page.route(replacementUrl, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patchAttempts.push({
        key: route.request().headers()["idempotency-key"],
        version: route.request().headers()["if-match"], body: route.request().postData(),
      });
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ accepted: true, replacedOrderId: replacementId });
      if (patchAttempts.length === 1) {
        committedBody = body;
        await route.abort("failed");
      } else {
        expect(body).toEqual(committedBody);
        await route.fulfill({ response });
      }
    });
    await editor.getByRole("button", { name: "Save replacement" }).click();
    await expect(editor.getByRole("alert")).toBeVisible();
    const afterCommittedPatch = await structuralSnapshot();
    await editor.getByRole("button", { name: "Save replacement" }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Remaining order replaced" })).toBeVisible();
    await page.unroute(replacementUrl);
    expect(patchAttempts).toHaveLength(2);
    expect(patchAttempts[1]).toEqual(patchAttempts[0]);
    expect(await structuralSnapshot()).toEqual(afterCommittedPatch);
    const replayedPatchBody = JSON.parse(patchAttempts[0].body!) as { clientOrderId: string };
    const replacementOrders = await db.marketOrder.findMany({ where: { userId: primary.id, clientOrderId: replayedPatchBody.clientOrderId } });
    expect(replacementOrders).toHaveLength(1);
    expect(replacementOrders[0]).toMatchObject({ status: "OPEN", limitPriceMilli: 35_000n, remainingQuantity: 1, postOnly: true });
  } finally {
    await Promise.all(contexts.map((context) => context.dispose()));
    await db.$disconnect();
  }
});
