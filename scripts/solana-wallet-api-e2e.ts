/** Real direct-route-handler integration, NOT HTTP/browser/transaction proof.
 * Owns a fresh temporary SQLite database and in-memory Ed25519 keys only.
 * Existing pinned local validator is read-only: no airdrops, grants or sends.
 * Run: node --import tsx scripts/solana-wallet-api-e2e.ts
 * Requires explicit GOOSEY_SOLANA_CLUSTER=localnet, GOOSEY_SOLANA_RPC_URL,
 * GOOSEY_SOLANA_PROGRAM_ID and GOOSEY_SOLANA_GENESIS_HASH. No defaults/files.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IssuedWalletLinkChallenge } from "../src/lib/solana/wallet-link-service";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const ORIGIN = "https://wallet-api-e2e.goosey.invalid";
function configuredRuntime() {
  for (const key of ["GOOSEY_SOLANA_CLUSTER", "GOOSEY_SOLANA_RPC_URL", "GOOSEY_SOLANA_PROGRAM_ID", "GOOSEY_SOLANA_GENESIS_HASH"]) {
    assert(process.env[key], `Explicit ${key} is required`);
  }
  const runtime = resolveSolanaRuntime(process.env);
  assert.equal(runtime.cluster, "localnet", "Wallet API E2E requires a pinned loopback localnet");
  return runtime;
}

async function parent() {
  const runtime = configuredRuntime();
  const directory = await mkdtemp(path.join(tmpdir(), "goosey-wallet-api-"));
  try {
    const database = path.join(directory, "journey.db");
    const handle = await open(database, "wx", 0o600); await handle.close();
    // Deliberately do not inherit developer database URLs, signing secrets,
    // mail settings or NODE_OPTIONS into the child. Only validated, explicitly
    // selected runtime fields cross the chain-configuration boundary.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG,
      NODE_ENV: "test", DATABASE_PROVIDER: "sqlite", DATABASE_URL: `file:${database}`,
      POSTGRES_DATABASE_URL: "", POSTGRES_DIRECT_DATABASE_URL: "", NEON_DATABASE_URL: "",
      APP_URL: ORIGIN, NEXT_PUBLIC_APP_URL: ORIGIN, NEXT_TELEMETRY_DISABLED: "1",
      GOOSEY_SOLANA_CLUSTER: runtime.cluster, GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl,
      GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash,
      REQUIRE_EMAIL_VERIFICATION: "true", SESSION_COOKIE_NAME: "goosey_wallet_api_e2e",
      AUTH_SECRET: randomBytes(32).toString("hex"), RATE_LIMIT_KEY_SECRET: randomBytes(32).toString("hex"),
      GOOSEY_TOKEN_SECRET: randomBytes(32).toString("hex"),
      SMTP_HOST: "", SMTP_USER: "", SMTP_PASS: "", SMTP_PASSWORD: "", EMAIL_FROM: "",
      GOOSEY_WALLET_API_CHILD: directory,
    };
    const migrate = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate", "--schema", "prisma/schema.prisma"],
      { cwd: root, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
    assert(!migrate.error && migrate.status === 0, `Isolated schema creation failed: ${migrate.error?.message ?? migrate.stderr}`);
    const child = spawnSync(process.execPath, ["--import", "tsx", script, "--child", directory],
      { cwd: root, env, timeout: 120_000, killSignal: "SIGKILL", stdio: "inherit" });
    assert(!child.error && child.status === 0, `Wallet handler integration failed (${child.error?.message ?? child.status})`);
  } finally {
    // Only the exact directory created above, after the bounded child has exited.
    await rm(directory, { recursive: true, force: true });
  }
}

async function child(directory: string) {
  const pinned = configuredRuntime();
  const { rpcUrl: RPC, genesisHash: GENESIS, programAddress: PROGRAM } = pinned;
  assert(directory && path.isAbsolute(directory));
  assert.equal(directory, process.env.GOOSEY_WALLET_API_CHILD);
  assert.equal(await realpath(path.dirname(directory)), await realpath(tmpdir()));
  assert(path.basename(directory).startsWith("goosey-wallet-api-"));
  assert.equal(process.env.DATABASE_URL, `file:${path.join(directory, "journey.db")}`);
  assert.equal(process.env.DATABASE_PROVIDER, "sqlite");
  assert.equal(process.env.REQUIRE_EMAIL_VERIFICATION, "true");
  assert.equal(process.env.GOOSEY_SOLANA_RPC_URL, RPC);
  assert.equal(process.env.GOOSEY_SOLANA_GENESIS_HASH, GENESIS);
  // Stateful application imports occur AFTER isolation checks, in a fresh process.
  const { db, requireDatabaseStartup } = await import("../src/lib/db");
  try {
    await requireDatabaseStartup();
    const { NextRequest } = await import("next/server");
    const { registerUser, loginUser, SESSION_COOKIE_NAME, revokeRequestSession } = await import("../src/lib/auth");
    const { sha256 } = await import("../src/lib/security");
    const { getBase58Decoder } = await import("@solana/kit");
    const { readGooseyConfiguration } = await import("../src/lib/solana/configuration");
    const { POST: issue } = await import("../src/app/api/solana/wallet/challenge/route");
    const { POST: verify } = await import("../src/app/api/solana/wallet/verify/route");
    const { GET: list } = await import("../src/app/api/solana/wallet/route");
    const runtime = resolveSolanaRuntime();
    const chainBefore = await readGooseyConfiguration(runtime);
    process.stdout.write(`Pinned local configuration verified at finalized slot ${chainBefore.finalizedSlot}; no chain writes.\n`);
    const request = (token: string | null, body?: unknown, origin = ORIGIN) => new NextRequest(`${ORIGIN}/api/solana/wallet`, {
      method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json",
        ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function expectError(response: Response, status: number, code: string) {
      const body = await response.json();
      assert.equal(response.status, status, JSON.stringify(body)); assert.equal(body.error?.code, code);
      assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
    }
    const password = randomBytes(24).toString("base64url") + "Aa1!";
    const alice = await registerUser({ email: "alice@wallet-api.invalid", username: "wallet_alice", displayName: "Wallet API Alice", password });
    const bob = await registerUser({ email: "bob@wallet-api.invalid", username: "wallet_bob", displayName: "Wallet API Bob", password });
    // Verification gate prevents registration grants. These are isolated auth
    // fixtures, not email-delivery proof; mark their emails verified without
    // invoking the grant-producing verification flow.
    await expectError(await issue(request(alice.session.token, { walletAddress: PROGRAM, password })), 403, "EMAIL_VERIFICATION_REQUIRED");
    await db.user.updateMany({ where: { id: { in: [alice.user.id, bob.user.id] } }, data: { emailVerifiedAt: new Date() } });
    const anotherLogin = await loginUser({ email: alice.user.email, password }); assert(anotherLogin);
    const economics = async () => ({
      users: await db.user.findMany({ orderBy: { id: "asc" }, select: { id: true, balanceMilli: true } }),
      accounts: await db.ledgerAccount.findMany({ orderBy: { id: "asc" } }),
      journals: await db.journalEntry.findMany({ orderBy: { id: "asc" } }),
      postings: await db.ledgerPosting.findMany({ orderBy: { id: "asc" } }),
      trades: await db.trade.count(), fills: await db.orderFill.count(), orders: await db.marketOrder.count(),
    });
    const before = await economics();
    assert.equal(before.journals.length, 0); assert.equal(before.postings.length, 0);
    assert(before.users.every(user => user.balanceMilli === 0n));
    assert(before.accounts.every(account => account.balanceMilli === 0n));
    const pair = generateKeyPairSync("ed25519"), wrongPair = generateKeyPairSync("ed25519");
    const walletAddress = getBase58Decoder().decode(new Uint8Array(pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32)));
    const signed = (issued: IssuedWalletLinkChallenge, signer = pair.privateKey) => ({
      challengeId: issued.id, challenge: issued.challenge,
      signedMessageBase64: Buffer.from(issued.challenge.message).toString("base64"),
      signatureBase64: sign(null, Buffer.from(issued.challenge.message), signer).toString("base64"),
    });
    await expectError(await issue(request(null, { walletAddress })), 401, "AUTHENTICATION_REQUIRED");
    await expectError(await list(request(null)), 401, "AUTHENTICATION_REQUIRED");
    await expectError(await issue(request(alice.session.token, { walletAddress }, "https://wrong.invalid")), 403, "FORBIDDEN");
    await expectError(await issue(request(alice.session.token, { walletAddress })), 400, "INVALID_REQUEST");
    await expectError(await issue(request(alice.session.token, { walletAddress, password: "Wrong-password-reauth-123!" })), 401, "REAUTHENTICATION_REQUIRED");
    assert.equal(await db.solanaWalletLinkChallenge.count(), 0, "Failed reauthentication cannot issue a challenge");
    const issuedResponse = await issue(request(alice.session.token, { walletAddress, password }));
    assert.equal(issuedResponse.status, 201, await issuedResponse.clone().text());
    const issued: IssuedWalletLinkChallenge = await issuedResponse.json();
    assert.equal(issued.challenge.uri, ORIGIN); assert.equal(issued.challenge.genesisHash, GENESIS);
    assert.equal(issued.challenge.walletAddress, walletAddress);
    const stored = await db.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } });
    assert.equal(stored.userId, alice.user.id); assert.equal(stored.consumedAt, null);
    assert.equal(stored.purpose, "LINK_WALLET_REAUTH_V1");
    assert.notEqual(stored.nonceHash, issued.challenge.nonce);
    await expectError(await verify(request(alice.session.token, signed(issued, wrongPair.privateKey))), 400, "INVALID_CHALLENGE");
    await expectError(await verify(request(bob.session.token, signed(issued))), 400, "INVALID_CHALLENGE");
    await expectError(await verify(request(anotherLogin.session.token, signed(issued))), 400, "INVALID_CHALLENGE");
    await expectError(await verify(request(alice.session.token, { ...signed(issued), challenge: { ...issued.challenge, nonce: "0".repeat(64) } })), 400, "INVALID_CHALLENGE");
    await expectError(await verify(request(alice.session.token, signed(issued), "https://wrong.invalid")), 403, "FORBIDDEN");
    assert.equal(await db.solanaWalletLink.count(), 0);
    assert.equal((await db.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt, null);
    const linked = await verify(request(alice.session.token, signed(issued)));
    assert.equal(linked.status, 200, await linked.clone().text());
    const linkedBody = await linked.json(); assert.equal(linkedBody.wallet.walletAddress, walletAddress);
    assert(!("userId" in linkedBody.wallet));
    const replacement = linked.cookies.get(SESSION_COOKIE_NAME)?.value;
    assert(replacement && replacement !== alice.session.token, "Successful verification must rotate the cookie");
    assert.match(linked.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert(!JSON.stringify(linkedBody).includes(replacement), "Session token must never appear in JSON");
    assert.equal(await db.session.findUnique({ where: { id: stored.sessionId } }), null, "Original session must be revoked");
    assert(await db.session.findUnique({ where: { tokenHash: sha256(replacement) } }), "Replacement session must exist");
    assert.equal(await db.solanaWalletLink.count(), 1);
    assert((await db.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt);
    await expectError(await verify(request(alice.session.token, signed(issued))), 401, "AUTHENTICATION_REQUIRED");
    await expectError(await list(request(alice.session.token)), 401, "AUTHENTICATION_REQUIRED");
    await expectError(await verify(request(replacement, signed(issued))), 400, "INVALID_CHALLENGE");
    assert.equal((await db.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).sessionId, stored.sessionId, "Consumed tombstone retains original session binding");
    await expectError(await issue(request(replacement, { walletAddress, password: "Wrong-password-reauth-123!" })), 401, "REAUTHENTICATION_REQUIRED");
    const listing = await list(request(replacement)); assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).items, [linkedBody.wallet]);
    const bobListing = await list(request(bob.session.token)); assert.equal(bobListing.status, 200);
    assert.deepEqual((await bobListing.json()).items, []);
    // Valid possession by another user cannot steal the already-linked wallet.
    const bobIssue = await issue(request(bob.session.token, { walletAddress, password })); assert.equal(bobIssue.status, 201);
    const bobChallenge: IssuedWalletLinkChallenge = await bobIssue.json();
    const conflict = await verify(request(bob.session.token, signed(bobChallenge)));
    await expectError(conflict, 409, "WALLET_LINK_CONFLICT");
    assert.equal(conflict.headers.get("set-cookie"), null, "Conflict cannot rotate cookie");
    assert(await db.session.findUnique({ where: { tokenHash: sha256(bob.session.token) } }), "Conflict must retain original session");
    assert.equal((await db.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: bobChallenge.id } })).consumedAt, null, "Conflict must roll back consumption");
    // Revocation uses the real authentication helper, not a manufactured cookie.
    await revokeRequestSession(request(bob.session.token));
    await expectError(await verify(request(bob.session.token, signed(bobChallenge))), 401, "AUTHENTICATION_REQUIRED");
    await expectError(await list(request(bob.session.token)), 401, "AUTHENTICATION_REQUIRED");
    // These environment-only checks never change the active DB singleton.
    process.env.GOOSEY_SOLANA_CLUSTER = "";
    await expectError(await issue(request(replacement, { walletAddress, password })), 503, "SOLANA_DISABLED");
    process.env.GOOSEY_SOLANA_CLUSTER = "localnet";
    process.env.GOOSEY_SOLANA_GENESIS_HASH = "11111111111111111111111111111111";
    await expectError(await issue(request(replacement, { walletAddress, password })), 503, "SOLANA_UNAVAILABLE");
    const otherGenesis = await list(request(replacement)); assert.equal(otherGenesis.status, 200);
    assert.deepEqual((await otherGenesis.json()).items, []);
    process.env.GOOSEY_SOLANA_GENESIS_HASH = GENESIS;
    assert.deepEqual(await economics(), before, "Wallet linking must not change DB cash, journals, postings or trading");
    assert.equal(await db.solanaWalletLink.count(), 1);
    const chainAfter = await readGooseyConfiguration(runtime);
    // Other tasks may legitimately use the shared validator. Do not assert its
    // global counters are unchanged; this runner has no chain write operations.
    assert.equal(chainAfter.config, chainBefore.config);
    process.stdout.write("PASS direct-handler integration: real password reauthentication, rotated cookie/session, preserved consumed nonce tombstone, SQLite service, Ed25519 signature, finalized pinned RPC; challenge/link/list/replay/wrong-signature/user/session/origin/conflict/disabled/network checks; rotation is not reauthentication; unchanged DB economics. NOT HTTP/browser or chain transaction proof.\n");
  } finally { await db.$disconnect(); }
}

try {
  if (process.argv[2] === "--child") await child(process.argv[3] ?? "");
  else { assert.equal(process.argv.length, 2, "No arguments supported"); await parent(); }
} catch (error) {
  // Never print request bodies, signing material, session tokens or challenge text.
  console.error(error instanceof Error ? error.message : "Wallet API integration failed");
  process.exitCode = 1;
}
