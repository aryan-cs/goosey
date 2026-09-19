import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import { startTestSmtp } from "./lib/test-smtp";

// This entire journey owns a disposable database and loopback mail receiver.
// Participants and their tokens/grants are created only through application APIs.
const runDir = await mkdtemp(path.join(tmpdir(), "goosey-email-onboarding-"));
const databaseUrl = `file:${path.join(runDir, "journey.db")}`;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
let web: ChildProcess | undefined;
let proxy: https.Server | undefined;
let smtp: Awaited<ReturnType<typeof startTestSmtp>> | undefined;
let deadline: NodeJS.Timeout | undefined;

function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try { await done; } finally { clearTimeout(timer); }
}

try {
  await writeFile(path.join(runDir, "journey.db"), "", { mode: 0o600 });
  // This isolated journey proves the verification gate and post-confirmation
  // grant. Production and ordinary local runs keep their configured default.
  const env = {
    ...process.env,
    DATABASE_PROVIDER: "sqlite", DATABASE_URL: databaseUrl,
    POSTGRES_DATABASE_URL: "", POSTGRES_DIRECT_DATABASE_URL: "",
    REQUIRE_EMAIL_VERIFICATION: "true",
    SESSION_COOKIE_NAME: "goosey_email_journey", STARTING_FEATHERS: "1000",
    RATE_LIMIT_KEY_SECRET: randomBytes(32).toString("hex"),
    GOOSEY_TOKEN_SECRET: randomBytes(32).toString("hex"),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], {
    env, timeout: 30_000, stdio: "pipe",
  });

  // A one-day certificate trusted only by this runner and its child web process.
  // No disabling certificate validation, external delivery or system trust edits.
  await writeFile(path.join(runDir, "cert.cnf"), [
    "[req]", "distinguished_name=dn", "x509_extensions=ext", "prompt=no",
    "[dn]", "CN=localhost", "[ext]", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "basicConstraints=critical,CA:TRUE", "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
    "extendedKeyUsage=serverAuth", "",
  ].join("\n"), { mode: 0o600 });
  const certPath = path.join(runDir, "cert.pem");
  const keyPath = path.join(runDir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-config", path.join(runDir, "cert.cnf")], { timeout: 15_000, stdio: "pipe" });
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  smtp = await startTestSmtp({ cert, key });
  const backendPort = await freePort();
  proxy = https.createServer({ key, cert }, (incoming, outgoing) => {
    const upstream = http.request({ hostname: "127.0.0.1", port: backendPort,
      path: incoming.url, method: incoming.method, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.setTimeout(15_000, () => upstream.destroy());
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.on("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy!.once("error", reject); proxy!.listen(0, "127.0.0.1", resolve); });
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  const origin = `https://127.0.0.1:${proxyAddress.port}`;
  const password = "Email-journey-only-password-2026!";
  const adminEmail = "operator@email-journey.goosey.test";
  await db.user.create({ data: { email: "system@email-journey.goosey.test", username: "email_system",
    displayName: "Email journey system", passwordHash: await hash(randomBytes(32).toString("hex"), 4), role: "SYSTEM", status: "ACTIVE" } });
  await db.user.create({ data: { email: adminEmail, username: "email_operator", displayName: "Email journey operator",
    passwordHash: await hash(password, 4), role: "ADMIN", status: "ACTIVE", emailVerifiedAt: new Date() } });

  web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
    env: { ...env, NODE_ENV: "production", NODE_EXTRA_CA_CERTS: certPath,
      APP_URL: origin, NEXT_PUBLIC_APP_URL: origin,
      EMAIL_VERIFICATION_URL: `${origin}/verify-email`, PASSWORD_RESET_URL: `${origin}/reset-password`,
      SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), SMTP_SECURE: "true", SMTP_REQUIRE_TLS: "true",
      SMTP_USER: "", SMTP_PASSWORD: "", SMTP_FROM: "Goosey <sender@email-journey.goosey.test>", SMTP_REPLY_TO: "",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain without printing possibly sensitive request context. Assertions below
  // report the failed stage/status, never passwords, session cookies or mail links.
  web.stdout?.resume(); web.stderr?.resume();
  let spawnError: Error | undefined;
  web.once("error", (error) => { spawnError = error; });
  deadline = setTimeout(() => { web?.kill("SIGKILL"); proxy?.closeAllConnections(); }, 90_000);

  async function api(route: string, expected: number, body?: Record<string, unknown>, cookie?: string, idempotencyKey?: string) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const result = await new Promise<{ status: number; body: Record<string, unknown>; cookie?: string }>((resolve, reject) => {
      const request = https.request(`${origin}${route}`, {
        ca: cert, method: payload ? "POST" : "GET", agent: false,
        headers: { Origin: origin, ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(cookie ? { Cookie: cookie } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      }, (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { raw += chunk; if (raw.length > 1_000_000) request.destroy(new Error("Response exceeded test bound")); });
        response.on("error", reject);
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: raw ? record(JSON.parse(raw)) : {},
            cookie: response.headers["set-cookie"]?.[0]?.split(";", 1)[0] }); } catch { reject(new Error(`Non-JSON response at ${route}`)); }
        });
      });
      request.setTimeout(15_000, () => request.destroy(new Error(`Request timed out at ${route}`)));
      request.on("error", reject); request.end(payload);
    });
    assert.equal(result.status, expected, `${route}: expected ${expected}, received ${result.status}`);
    return result;
  }

  for (let attempt = 0; ; attempt++) {
    if (spawnError) throw spawnError;
    assert(web.exitCode === null && web.signalCode === null, "Test web process exited before readiness");
    try { await api("/api/health", 200); break; } catch { assert(attempt < 60, "Test web server did not become healthy"); await delay(200); }
  }

  function actionToken(recipient: string, pathname: string, next: string): string {
    const mail = smtp!.messages.filter((message) => message.recipients.includes(recipient)).at(-1);
    assert(mail, "Expected an actual SMTP-delivered message");
    const split = mail.raw.indexOf("\r\n\r\n");
    assert(split >= 0, "Expected MIME header/body separator");
    const headers = mail.raw.slice(0, split);
    let body = mail.raw.slice(split + 4);
    if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(headers)) {
      body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    } else if (/Content-Transfer-Encoding:\s*base64/i.test(headers)) {
      body = Buffer.from(body, "base64").toString("utf8");
    }
    const links = body.match(/https:\/\/[^\s]+/g) ?? [];
    assert.equal(links.length, 1, "Expected exactly one account action link");
    const link = new URL(links[0]);
    assert.equal(link.origin, origin); assert.equal(link.pathname, pathname);
    assert.equal(link.searchParams.get("next"), next);
    assert.equal(link.searchParams.has("token"), false);
    const token = new URLSearchParams(link.hash.slice(1)).get("token");
    assert(token && /^[A-Za-z0-9_-]{43}$/.test(token), "Expected fragment token in received mail");
    return token;
  }

  const marketSlug = "email-journey-first-trade";
  const next = `/markets/${marketSlug}`;
  const participants: { email: string; cookie: string; id: string }[] = [];
  for (const username of ["email_yes", "email_no"]) {
    const email = `${username}@email-journey.goosey.test`;
    const device = await api("/api/auth/registration-device", 204);
    assert(device.cookie, "Device bootstrap must issue a registration cookie");
    const registration = await api("/api/auth/register", 201, { email, username, password, acceptedCodeOfConduct: true }, device.cookie);
    assert(registration.cookie, "Registration must issue a session");
    assert.equal(registration.body.balanceMilli, "0");
    const id = record(registration.body.user).id;
    assert.equal(typeof id, "string");
    const cookie = registration.cookie;
    const blocked = await api("/api/portfolio", 403, undefined, cookie);
    assert.equal(record(blocked.body.error).code, "EMAIL_VERIFICATION_REQUIRED");
    await api("/api/auth/email-verification/request", 202, { email, next }, cookie);
    const token = actionToken(email, "/verify-email", next);
    const confirmation = await api("/api/auth/email-verification/confirm", 200, { token }, cookie);
    assert.equal(confirmation.body.welcomeGrantIssued, true);
    assert.equal(confirmation.body.requiresSignIn, false);
    await api("/api/auth/email-verification/confirm", 400, { token }, cookie);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.balanceMilli, 1_000_000n); assert(user.emailVerifiedAt);
    participants.push({ email, cookie, id: id as string });
  }
  assert.equal(smtp.messages.length, 2);
  const beforeUnknown = await db.accountToken.count();
  await api("/api/auth/email-verification/request", 202, { email: "absent@email-journey.goosey.test", next });
  assert.equal(smtp.messages.length, 2); assert.equal(await db.accountToken.count(), beforeUnknown);

  const adminLogin = await api("/api/auth/login", 200, { email: adminEmail, password });
  assert(adminLogin.cookie);
  const created = await api("/api/admin/markets", 201, {
    slug: marketSlug, title: "Will the email onboarding journey complete?", shortTitle: "Email onboarding journey",
    description: "Disposable integration market for the real email-to-trade journey.",
    rules: "This test contract is never published outside this disposable database.",
    resolutionSource: "Automated integration assertions", category: "Testing", pricingModel: "ORDER_BOOK", status: "OPEN",
    closesAt: new Date(Date.now() + 86_400_000).toISOString(), resolvesAt: new Date(Date.now() + 172_800_000).toISOString(), feeBps: 0,
  }, adminLogin.cookie, "email-journey-create-market");
  const marketId = record(created.body.market).id;
  assert.equal(typeof marketId, "string");
  const orders = [
    { marketSlug, clientOrderId: "email-journey-yes-order", outcome: "YES", action: "BUY", quantity: 2, limitPriceMilli: "40000" },
    { marketSlug, clientOrderId: "email-journey-no-order", outcome: "NO", action: "BUY", quantity: 2, limitPriceMilli: "60000" },
  ];
  for (const [index, order] of orders.entries()) {
    const placed = await api("/api/v1/orders", 201, order, participants[index].cookie, order.clientOrderId);
    assert.equal(placed.body.accepted, true);
    const placedOrder = record(placed.body.order);
    assert.equal(typeof placedOrder.orderId, "string");
    const replay = await api("/api/v1/orders", 201, order, participants[index].cookie, order.clientOrderId);
    assert.equal(replay.body.accepted, true);
    assert.equal(record(replay.body.order).orderId, placedOrder.orderId);
    assert.deepEqual(replay.body, placed.body, "Replay must return the original committed response");
  }
  assert.equal(await db.marketOrder.count(), 2);
  assert.equal(await db.orderFill.count(), 1);
  for (const [index, participant] of participants.entries()) {
    const user = await db.user.findUniqueOrThrow({ where: { id: participant.id } });
    assert.equal(user.balanceMilli, index === 0 ? 920_000n : 880_000n);
    const position = await db.position.findUniqueOrThrow({ where: { userId_marketId: { userId: user.id, marketId: marketId as string } } });
    assert.equal(position.yesShares, index === 0 ? 2 : 0);
    assert.equal(position.noShares, index === 0 ? 0 : 2);
    await api("/api/portfolio", 200, undefined, participant.cookie);
  }

  const participant = participants[0];
  const secondSession = await api("/api/auth/login", 200, { email: participant.email, password });
  assert(secondSession.cookie);
  await api("/api/auth/password-reset/request", 202, { email: participant.email, next });
  const resetToken = actionToken(participant.email, "/reset-password", next);
  const newPassword = "Email-journey-new-password-2026!";
  await api("/api/auth/password-reset/confirm", 200, { token: resetToken, newPassword }, participant.cookie);
  await api("/api/auth/password-reset/confirm", 400, { token: resetToken, newPassword });
  for (const cookie of [participant.cookie, secondSession.cookie]) await api("/api/portfolio", 401, undefined, cookie);
  await api("/api/auth/login", 401, { email: participant.email, password });
  const restoredSession = await api("/api/auth/login", 200, { email: participant.email, password: newPassword });
  assert(restoredSession.cookie);
  await api("/api/portfolio", 200, undefined, restoredSession.cookie);
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: participant.id } })).balanceMilli, 920_000n);

  smtp.rejectDelivery = true;
  const tokensBeforeFailure = await db.accountToken.count();
  await api("/api/auth/password-reset/request", 503, { email: participants[1].email, next });
  assert.equal(await db.accountToken.count(), tokensBeforeFailure, "Undelivered token must be removed");
  assert.equal(smtp.messages.length, 3);
  smtp.rejectDelivery = false;
  await api("/api/auth/password-reset/request", 202, { email: participants[1].email, next });
  assert.equal(smtp.messages.length, 4);
  actionToken(participants[1].email, "/reset-password", next);

  await stopChild(web);
  await db.$disconnect();
  const reconciliation = execFileSync(process.execPath, ["--import", "tsx", "scripts/reconcile.ts"], { env, timeout: 30_000, encoding: "utf8" });
  process.stdout.write(reconciliation);
  console.log(JSON.stringify({ status: "passed", verifiedParticipants: 2, tlsEmailsReceived: smtp.messages.length,
    fills: 1, replayedOrders: 2, passwordResetRevokedSessions: 2, failedDeliveryCleanedUp: true }));
} finally {
  if (deadline) clearTimeout(deadline);
  await stopChild(web);
  if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy!.close(() => resolve())); }
  await smtp?.close();
  await db.$disconnect();
  await rm(runDir, { recursive: true, force: true });
}
