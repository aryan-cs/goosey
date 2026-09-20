/** Real HTTP security regression suite. Run after npm run build.
 * Owns a disposable database and server; never accepts an external database URL.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const runDir = await mkdtemp(join(tmpdir(), "goosey-security-http-"));
const databaseUrl = `file:${join(runDir, "security.db")}`;
// Assign before importing any application module: imports initialize Prisma.
Object.assign(process.env, {
  DATABASE_PROVIDER: "sqlite", DATABASE_URL: databaseUrl, STARTING_FEATHERS: "1000",
  RATE_LIMIT_KEY_SECRET: randomBytes(32).toString("hex"),
  GOOSEY_TOKEN_SECRET: randomBytes(32).toString("hex"),
  SESSION_COOKIE_NAME: "goosey_security_test_session", TRUST_PROXY: "0",
});
delete process.env.POSTGRES_DATABASE_URL;
delete process.env.POSTGRES_DIRECT_DATABASE_URL;
delete process.env.VERCEL;
// Integration mail must never leave the machine, even if a developer has SMTP configured.
for (const key of Object.keys(process.env)) if (/^(SMTP_|RESEND_|EMAIL_PROVIDER)/.test(key)) process.env[key] = "";
// Empty explicit overrides also prevent Next from loading live SMTP from .env.
Object.assign(process.env, { SMTP_HOST: "", SMTP_PORT: "", SMTP_FROM: "", SMTP_USER: "", SMTP_PASSWORD: "" });
const { db } = await import("../src/lib/db");
const { hashPassword, createSession } = await import("../src/lib/auth");
const { sha256 } = await import("../src/lib/security");
let server: ChildProcess | undefined;
let serverLog = "";
let checks = 0;
const failures: string[] = [];
let origin = "";
const password = "Security-integration-password-42!";
type Actor = { id: string; cookie: string };
type HttpOptions = { method?: string; body?: unknown; actor?: Actor; headers?: Record<string, string>; noOrigin?: boolean; key?: string };

function serialized(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}
async function request(path: string, options: HttpOptions = {}) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const response = await fetch(`${origin}${path}`, {
    method, redirect: "manual", signal: AbortSignal.timeout(20_000),
    headers: {
      ...(method !== "GET" && !options.noOrigin ? { Origin: origin } : {}),
      ...(options.actor ? { Cookie: options.actor.cookie } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      "Idempotency-Key": options.key ?? randomUUID(), ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text); } catch { /* 204 and 405 may have no JSON body. */ }
  return { response, status: response.status, body, text };
}
// Rate-limit counters may change on rejected requests. Every protected business
// table below must remain byte-for-byte identical; no mocked database is involved.
async function snapshot() {
  return serialized(await Promise.all([
    db.user.findMany({ orderBy: { id: "asc" } }),
    db.market.findMany({ orderBy: { id: "asc" } }),
    db.ledgerAccount.findMany({ orderBy: { id: "asc" } }),
    db.journalEntry.findMany({ orderBy: { id: "asc" }, include: { postings: { orderBy: { id: "asc" } } } }),
    db.position.findMany({ orderBy: { id: "asc" } }),
    db.trade.findMany({ orderBy: { id: "asc" } }),
    db.marketOrder.findMany({ orderBy: { id: "asc" }, include: { reservation: true } }),
    db.orderFill.findMany({ orderBy: { id: "asc" } }),
    db.comment.findMany({ orderBy: { id: "asc" } }),
    db.notification.findMany({ orderBy: { id: "asc" } }),
    db.session.findMany({ orderBy: { id: "asc" } }),
    db.registrationDevice.findMany({ orderBy: { id: "asc" } }),
    db.marketResolutionProposal.findMany({ orderBy: { id: "asc" } }),
  ]));
}
async function check(label: string, run: () => Promise<void>) {
  try { await run(); checks++; console.log(`PASS ${label}`); }
  catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); console.error(`FAIL ${failures.at(-1)}`); }
}
async function rejected(label: string, path: string, options: HttpOptions, statuses: number[]) {
  await check(label, async () => {
    const before = await snapshot();
    const result = await request(path, options);
    assert(statuses.includes(result.status), `Expected ${statuses}, got ${result.status}: ${result.text.slice(0, 500)}`);
    assert.equal(await snapshot(), before, "Rejected request mutated protected database state");
  });
}
async function registrationDeviceCookie(): Promise<string> {
  const result = await request("/api/auth/registration-device");
  assert.equal(result.status, 204, result.text);
  const cookie = result.response.headers.getSetCookie().find((value) => value.startsWith("goosey_registration_device="))?.split(";", 1)[0];
  assert(cookie, "Device bootstrap must issue a registration cookie");
  return cookie;
}
async function register(label: string): Promise<Actor> {
  const deviceCookie = await registrationDeviceCookie();
  const result = await request("/api/auth/register", { headers: { Cookie: deviceCookie }, body: { email: `${label}@goosey.test`, username: label, password, acceptedCodeOfConduct: true } });
  assert.equal(result.status, 201, result.text);
  const cookie = result.response.headers.getSetCookie().find((value) => value.startsWith(`${process.env.SESSION_COOKIE_NAME}=`))?.split(";", 1)[0];
  assert(cookie, "Registration must return a session cookie");
  const user = await db.user.findUniqueOrThrow({ where: { username: label } });
  assert.equal(user.balanceMilli, 0n);
  return { id: user.id, cookie };
}
async function verify(actor: Actor, concurrentRequests = 1) {
  const token = randomBytes(32).toString("base64url");
  await db.accountToken.create({ data: { userId: actor.id, tokenHash: sha256(token), purpose: "EMAIL_VERIFICATION", expiresAt: new Date(Date.now() + 60_000) } });
  const attempts = await Promise.all(Array.from({ length: concurrentRequests }, () => request("/api/auth/email-verification/confirm", { body: { token } })));
  assert.equal(attempts.filter((result) => result.status === 200).length, 1, serialized(attempts.map(({ status, body }) => ({ status, body }))));
  assert(attempts.every((result) => [200, 400].includes(result.status)));
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).balanceMilli, 1_000_000n);
  return token;
}
async function main() {
  await readFile(join(root, ".next/BUILD_ID"));
  await writeFile(join(runDir, "security.db"), "");
  const pushed = spawnSync(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "db", "push", "--skip-generate", "--schema", join(root, "prisma/schema.prisma")], { cwd: root, env: process.env, encoding: "utf8" });
  assert.equal(pushed.status, 0, pushed.stderr);
  const portServer = createServer();
  await new Promise<void>((resolveListen) => portServer.listen(0, "127.0.0.1", resolveListen));
  const address = portServer.address(); assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => portServer.close((error) => error ? reject(error) : resolveClose()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root, env: { ...process.env, NODE_ENV: "production", APP_URL: origin, NEXT_PUBLIC_APP_URL: origin, EMAIL_VERIFICATION_URL: `${origin}/verify-email` }, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (data: Buffer) => { serverLog += data.toString(); });
  server.stderr?.on("data", (data: Buffer) => { serverLog += data.toString(); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${serverLog}`);
    try { if ((await request("/api/health")).status === 200) break; } catch { /* Wait for readiness. */ }
    await delay(100);
  }
  const alice = await register("security_alice");
  await rejected("unverified account cannot trade", "/api/v1/orders", { actor: alice, body: { marketSlug: "security-book", clientOrderId: randomUUID(), outcome: "YES", action: "BUY", limitPriceMilli: "40000", quantity: 1 } }, [403]);
  const aliceToken = await verify(alice);
  const bob = await register("security_bob");
  await check("simultaneous verification issues exactly one welcome grant", async () => { await verify(bob, 4); });
  await rejected("welcome token replay cannot issue more feathers", "/api/auth/email-verification/confirm", { body: { token: aliceToken } }, [400]);
  const admin = await db.user.create({ data: { email: "security_admin@goosey.test", username: "security_admin", displayName: "Security admin", passwordHash: await hashPassword(password), role: "ADMIN", emailVerifiedAt: new Date() } });
  const adminSession = await db.$transaction((tx) => createSession(tx, admin.id));
  const adminActor = { id: admin.id, cookie: `${process.env.SESSION_COOKIE_NAME}=${adminSession.token}` };
  const marketBody = { slug: "security-book", title: "Will the isolated HTTP security checks pass?", shortTitle: "Security test", description: "Disposable integration market for real HTTP authorization testing.", rules: "Only evaluated inside the disposable regression database.", resolutionSource: "Integration test assertions", category: "Testing", status: "OPEN", pricingModel: "ORDER_BOOK", closesAt: new Date(Date.now() + 3_600_000).toISOString(), resolvesAt: new Date(Date.now() + 7_200_000).toISOString(), payoutMilli: "100000", feeBps: 0 };
  const created = await request("/api/admin/markets", { actor: adminActor, body: marketBody });
  assert.equal(created.status, 201, created.text);
  const market = await db.market.findUniqueOrThrow({ where: { slug: marketBody.slug } });
  const order = { marketSlug: market.slug, clientOrderId: randomUUID(), outcome: "YES", action: "BUY", limitPriceMilli: "40000", quantity: 2, timeInForce: "GTC" };
  for (const [field, value] of Object.entries({ balanceMilli: "999999999999", realizedPnlMilli: "999999999999", role: "ADMIN", status: "ACTIVE", rank: 1, userId: bob.id, emailVerifiedAt: new Date().toISOString() })) {
    await rejected(`profile rejects injected ${field}`, "/api/profile", { method: "PATCH", actor: alice, body: { displayName: "Still Alice", [field]: value } }, [400]);
  }
  await rejected("registration rejects forged privileged fields", "/api/auth/register", { body: { email: "security_forged@goosey.test", username: "security_forged", password, acceptedCodeOfConduct: true, role: "ADMIN", balanceMilli: "999999", emailVerifiedAt: new Date().toISOString() } }, [400]);
  await rejected("login rejects injected role and balance", "/api/auth/login", { body: { email: "security_alice@goosey.test", password, role: "ADMIN", balanceMilli: "999999999" } }, [400]);
  const duplicateDeviceCookie = await registrationDeviceCookie();
  await rejected("email casing cannot claim a second welcome identity", "/api/auth/register", { headers: { Cookie: duplicateDeviceCookie }, body: { email: "SECURITY_ALICE@GOOSEY.TEST", username: "security_duplicate", password, acceptedCodeOfConduct: true } }, [409]);
  for (const [label, actor] of [["anonymous", undefined], ["forged cookie", { id: alice.id, cookie: `${process.env.SESSION_COOKIE_NAME}=${alice.id}; role=ADMIN; balanceMilli=99999999` }]] as const) {
    await rejected(`${label} cannot submit orders`, "/api/v1/orders", { actor, body: order }, [401]);
  }
  await rejected("cross-origin financial mutation", "/api/v1/orders", { actor: alice, body: order, headers: { Origin: "https://attacker.invalid" } }, [403]);
  await rejected("missing-origin financial mutation", "/api/v1/orders", { actor: alice, body: order, noOrigin: true }, [403]);
  for (const path of ["/api/admin/markets", ...["pause", "resume", "close", "resolve"].map((action) => `/api/admin/markets/${market.id}/${action}`)]) {
    await rejected(`regular user denied ${path}`, path, { actor: alice, body: { ...marketBody, expectedVersion: 0, resolution: "YES", userId: admin.id }, headers: { "x-user-role": "ADMIN", "x-user-id": admin.id } }, [403]);
  }
  for (const path of ["/api/admin/audit-logs", "/api/admin/resolution-proposals", "/api/admin/invites", "/api/admin/reports"]) {
    await rejected(`regular user denied ${path}`, path, { actor: alice }, [403]);
  }
  await rejected("leaderboard is not writable", "/api/leaderboard", { actor: alice, method: "PATCH", body: { userId: alice.id, rank: 1, balanceMilli: "999999999" } }, [405]);
  await rejected("public market is not writable", `/api/markets/${market.slug}`, { actor: alice, method: "PATCH", body: { probabilityYesBps: 10000, resolution: "YES", payoutMilli: "99999999" } }, [405]);
  for (const [field, value] of Object.entries({ userId: bob.id, balanceMilli: "999999", feeBps: -10000, filledQuantity: 2, reservedPrincipalMilli: "0", marketId: market.id })) {
    await rejected(`order rejects injected ${field}`, "/api/v1/orders", { actor: alice, body: { ...order, [field]: value } }, [400]);
  }
  for (const quantity of [-1, 0, 0.5, 10_000_001, Number.MAX_SAFE_INTEGER]) {
    await rejected(`order rejects quantity ${quantity}`, "/api/v1/orders", { actor: alice, body: { ...order, quantity } }, [400]);
  }
  for (const limitPriceMilli of ["-1", "0", "1e5", "1000000000000000000000000000"]) {
    await rejected(`order rejects price ${limitPriceMilli}`, "/api/v1/orders", { actor: alice, body: { ...order, limitPriceMilli } }, [400]);
  }
  const key = randomUUID();
  const placed = await request("/api/v1/orders", { actor: alice, body: order, key });
  assert.equal(placed.status, 201, placed.text);
  const orderId = (placed.body.order as { orderId: string }).orderId;
  await check("concurrent order replay reserves cash once", async () => {
    const before = await snapshot();
    const replay = await Promise.all(Array.from({ length: 4 }, () => request("/api/v1/orders", { actor: alice, body: order, key })));
    for (const result of replay) { assert.equal(result.status, 201, result.text); assert.equal((result.body.order as { orderId: string }).orderId, orderId); }
    assert.equal(await snapshot(), before);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: alice.id } })).balanceMilli, 920_000n);
  });
  await rejected("idempotency key cannot change accepted economics", "/api/v1/orders", { actor: alice, body: { ...order, quantity: 3 }, key }, [409]);
  await rejected("other participant cannot cancel order", `/api/v1/orders/${orderId}`, { actor: bob, method: "DELETE" }, [403, 404]);
  await rejected("other participant cannot replace order", `/api/v1/orders/${orderId}`, { actor: bob, method: "PATCH", headers: { "If-Match": "order-version-0" }, body: { clientOrderId: randomUUID(), quantity: 1, limitPriceMilli: "1000" } }, [403, 404]);
  await check("private order list ignores forged principal", async () => {
    const result = await request(`/api/v1/orders?userId=${alice.id}`, { actor: bob });
    assert([200, 400].includes(result.status), result.text);
    assert(!result.text.includes(orderId), "Alice's private order leaked to Bob");
  });
  const bobSession = await db.session.findFirstOrThrow({ where: { userId: bob.id } });
  const note = await db.notification.create({ data: { userId: bob.id, type: "TEST", title: "Private security fixture", body: "Private test notification" } });
  const comment = await db.comment.create({ data: { userId: bob.id, marketId: market.id, body: "Original owner's comment" } });
  await rejected("other user's session cannot be revoked", "/api/auth/sessions", { actor: alice, method: "DELETE", body: { sessionId: bobSession.id } }, [404]);
  await rejected("other user's notification cannot be marked read", `/api/notifications/${note.id}`, { actor: alice, method: "PATCH" }, [404]);
  await rejected("other user's comment cannot be edited", `/api/comments/${comment.id}`, { actor: alice, method: "PATCH", body: { body: "Injected replacement" } }, [403]);
  await rejected("other user's comment cannot be deleted", `/api/comments/${comment.id}`, { actor: alice, method: "DELETE" }, [403]);
  const match = await request("/api/v1/orders", { actor: bob, body: { ...order, clientOrderId: randomUUID(), outcome: "NO", limitPriceMilli: "60000" } });
  assert.equal(match.status, 201, match.text);
  const secondMarket = await request("/api/admin/markets", { actor: adminActor, body: { ...marketBody, slug: "security-second-book" } });
  assert.equal(secondMarket.status, 201, secondMarket.text);
  await check("concurrent markets cannot double-spend a shared wallet", async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: alice.id } });
    const attempts = await Promise.all([market.slug, "security-second-book"].map((marketSlug) => request("/api/v1/orders", {
      actor: alice, body: { ...order, marketSlug, clientOrderId: randomUUID(), quantity: 15 },
    })));
    assert.equal(attempts.filter((result) => result.status === 201 && result.body.accepted === true).length, 1, serialized(attempts.map(({ status, body }) => ({ status, body }))));
    assert(attempts.every((result) => [201, 409, 422].includes(result.status)));
    const after = await db.user.findUniqueOrThrow({ where: { id: alice.id } });
    assert.equal(after.balanceMilli, before.balanceMilli - 600_000n);
    assert(after.balanceMilli >= 0n);
  });
  const lmsrMarket = await request("/api/admin/markets", { actor: adminActor, body: { ...marketBody, slug: "security-lmsr", pricingModel: "LMSR", liquidityParameter: 40 } });
  assert.equal(lmsrMarket.status, 201, lmsrMarket.text);
  const quote = await request("/api/markets/security-lmsr/quote", { actor: bob, body: { side: "YES", action: "BUY", quantity: 1 } });
  assert.equal(quote.status, 201, quote.text);
  const tradeBody = { quoteId: quote.body.quoteId, marketVersion: quote.body.marketVersion, maxDebitMilli: quote.body.totalDebitMilli };
  await rejected("another user cannot execute a stolen quote", "/api/markets/security-lmsr/trades", { actor: alice, body: tradeBody }, [403, 404]);
  await rejected("trade rejects forged debit and user identity", "/api/markets/security-lmsr/trades", { actor: bob, body: { ...tradeBody, userId: alice.id, totalDebitMilli: "0" } }, [400]);
  await rejected("slippage bound cannot force a free trade", "/api/markets/security-lmsr/trades", { actor: bob, body: { ...tradeBody, maxDebitMilli: "0" } }, [422]);
  const tradeKey = randomUUID();
  await check("concurrent quote execution and replay debit once", async () => {
    const before = await db.user.findUniqueOrThrow({ where: { id: bob.id } });
    const attempts = await Promise.all(Array.from({ length: 4 }, () => request("/api/markets/security-lmsr/trades", { actor: bob, body: tradeBody, key: tradeKey })));
    for (const result of attempts) assert.equal(result.status, 201, result.text);
    const ids = new Set(attempts.map((result) => (result.body.trade as { id: string }).id));
    assert.equal(ids.size, 1);
    assert.equal(await db.trade.count(), 1);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: bob.id } })).balanceMilli, before.balanceMilli - BigInt(String(quote.body.totalDebitMilli)));
  });
  await rejected("consumed quote cannot execute with a fresh key", "/api/markets/security-lmsr/trades", { actor: bob, body: tradeBody }, [409]);
  // Fund one isolated participant explicitly through a balanced fixture journal.
  // The skew itself is then created by real HTTP buys, never fabricated shares.
  const whale = await db.user.create({ data: { email: "security_whale@goosey.test", username: "security_whale", displayName: "Security liquidity fixture", passwordHash: await hashPassword(password), emailVerifiedAt: new Date() } });
  await db.$transaction(async (tx) => {
    const source = await tx.ledgerAccount.create({ data: { ownerType: "SYSTEM", ownerId: "security-http-fixture", purpose: "FIXTURE_ISSUANCE", allowsNegative: true, balanceMilli: -100_000_000n } });
    const wallet = await tx.ledgerAccount.create({ data: { ownerType: "USER", ownerId: whale.id, purpose: "USER_FEATHERS", balanceMilli: 100_000_000n } });
    await tx.journalEntry.create({ data: { type: "FIXTURE_GRANT", referenceType: "USER", referenceId: whale.id, idempotencyScope: "SECURITY_HTTP_FIXTURE", idempotencyKey: whale.id, actorUserId: whale.id, postings: { create: [{ ledgerAccountId: source.id, amountMilli: -100_000_000n }, { ledgerAccountId: wallet.id, amountMilli: 100_000_000n }] } } });
    await tx.user.update({ where: { id: whale.id }, data: { balanceMilli: 100_000_000n } });
  });
  const whaleSession = await db.$transaction((tx) => createSession(tx, whale.id));
  const whaleActor = { id: whale.id, cookie: `${process.env.SESSION_COOKIE_NAME}=${whaleSession.token}` };
  for (const [actor, side, quantity] of [[whaleActor, "YES", 1000], [alice, "NO", 1]] as const) {
    const skewQuote = await request("/api/markets/security-lmsr/quote", { actor, body: { side, action: "BUY", quantity } });
    assert.equal(skewQuote.status, 201, skewQuote.text);
    const skewTrade = await request("/api/markets/security-lmsr/trades", { actor, body: { quoteId: skewQuote.body.quoteId, marketVersion: skewQuote.body.marketVersion, maxDebitMilli: skewQuote.body.totalDebitMilli } });
    assert.equal(skewTrade.status, 201, skewTrade.text);
  }
  const visible = await request("/api/profile", { actor: alice, method: "PATCH", body: { leaderboardVisible: true } });
  assert.equal(visible.status, 200, visible.text);
  await check("negligible-value holding cannot crash public leaderboard", async () => {
    const result = await request("/api/leaderboard");
    assert.equal(result.status, 200, result.text);
    assert(result.text.includes("security_alice"));
  });
  await check("negligible-value holding cannot crash private portfolio", async () => {
    const result = await request("/api/portfolio", { actor: alice });
    assert.equal(result.status, 200, result.text);
  });
  await check("matched trades conserve every milli-feather", async () => {
    assert.equal(await db.orderFill.count(), 1);
    for (const journal of await db.journalEntry.findMany({ include: { postings: true } })) {
      assert(journal.postings.length >= 2);
      assert.equal(journal.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n), 0n);
    }
    for (const account of await db.ledgerAccount.findMany({ include: { postings: true } })) {
      assert.equal(account.balanceMilli, account.postings.reduce((sum, posting) => sum + posting.amountMilli, 0n));
      if (!account.allowsNegative) assert(account.balanceMilli >= 0n);
    }
    for (const actor of [alice, bob]) {
      const wallet = await db.ledgerAccount.findFirstOrThrow({ where: { ownerType: "USER", ownerId: actor.id, purpose: "USER_FEATHERS" } });
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: actor.id } })).balanceMilli, wallet.balanceMilli);
      assert.equal(await db.journalEntry.count({ where: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: actor.id } }), 1);
    }
  });
  await check("revoked session cannot finish a previously authenticated streaming order", async () => {
    const streamingSession = await db.$transaction((tx) => createSession(tx, bob.id));
    const sessionRow = await db.session.findUniqueOrThrow({ where: { tokenHash: sha256(streamingSession.token) } });
    const body = JSON.stringify({ ...order, marketSlug: "security-second-book", clientOrderId: randomUUID(), quantity: 1, limitPriceMilli: "1000" });
    let pendingRequest: ReturnType<typeof httpRequest> | undefined;
    const result = new Promise<{ status: number; text: string }>((resolveResponse, reject) => {
      pendingRequest = httpRequest(`${origin}/api/v1/orders`, {
        method: "POST", headers: { Origin: origin, Cookie: `${process.env.SESSION_COOKIE_NAME}=${streamingSession.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Idempotency-Key": randomUUID() },
      }, (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => { text += chunk.toString(); });
        response.on("end", () => resolveResponse({ status: response.statusCode ?? 0, text }));
      });
      pendingRequest.setTimeout(20_000, () => pendingRequest?.destroy(new Error("Streaming request timed out")));
      pendingRequest.on("error", reject);
      pendingRequest.write(body.slice(0, -1));
    });
    // Let requireUser finish while readJsonObject waits for the final byte.
    await delay(500);
    const revoked = await request("/api/auth/sessions", { actor: bob, method: "DELETE", body: { sessionId: sessionRow.id } });
    assert.equal(revoked.status, 200, revoked.text);
    const before = await snapshot();
    pendingRequest!.end(body.slice(-1));
    const response = await result;
    assert.equal(response.status, 401, response.text);
    assert.equal(await snapshot(), before, "Revoked streaming request committed protected state");
  });
  const expired = await db.$transaction((tx) => createSession(tx, alice.id));
  await db.session.updateMany({ where: { tokenHash: sha256(expired.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await rejected("expired session cannot trade", "/api/v1/orders", { actor: { id: alice.id, cookie: `${process.env.SESSION_COOKIE_NAME}=${expired.token}` }, body: order }, [401]);
  const revoked = await db.$transaction((tx) => createSession(tx, alice.id));
  await db.session.deleteMany({ where: { tokenHash: sha256(revoked.token) } });
  await rejected("revoked session cannot trade", "/api/v1/orders", { actor: { id: alice.id, cookie: `${process.env.SESSION_COOKIE_NAME}=${revoked.token}` }, body: order }, [401]);
  await db.user.update({ where: { id: alice.id }, data: { status: "SUSPENDED" } });
  await rejected("suspended user cannot reuse existing cookie", "/api/v1/orders", { actor: alice, body: order }, [401, 403]);
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log(JSON.stringify({ ok: true, checks, transport: "real HTTP", database: "disposable SQLite", productionBuild: true }));
}

try { await main(); }
catch (error) { console.error(error); console.error(serverLog.slice(-12_000)); process.exitCode = 1; }
finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise<void>((done) => server!.once("exit", () => done())), delay(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await db.$disconnect();
  await rm(runDir, { recursive: true, force: true });
}
