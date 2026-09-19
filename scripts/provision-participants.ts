/** Explicit operator provisioning; dry-run unless --apply. Never prints credentials. */
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalizeEmail, canonicalizeUsername, isValidPassword, sha256 } from "../src/lib/security";
import { runSerializableTransaction } from "../src/lib/serializable-transaction";

type Account = { username: string; email: string; password: string; startingFeathers: number };
type Manifest = { batchId: string; appUrl: string; accounts: Account[] };
class ProvisioningError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProvisioningError(message);
}
function validateManifest(value: unknown): Manifest {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "Manifest must be an object.");
  const input = value as Record<string, unknown>;
  assert(Object.keys(input).every(key => ["batchId", "appUrl", "accounts"].includes(key)), "Unknown manifest field.");
  assert(typeof input.batchId === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(input.batchId), "Invalid batch identifier.");
  assert(typeof input.appUrl === "string", "Missing application origin.");
  let origin: URL;
  try { origin = new URL(input.appUrl); } catch { throw new ProvisioningError("Invalid application origin."); }
  assert(origin.protocol === "https:" && origin.origin === input.appUrl, "Application must be an exact HTTPS origin.");
  assert(Array.isArray(input.accounts) && input.accounts.length > 0 && input.accounts.length <= 10000, "Invalid account count.");
  const usernames = new Set<string>();
  const emails = new Set<string>();
  const passwords = new Set<string>();
  for (const [index, value] of input.accounts.entries()) {
    const label = `Account ${index + 1}`;
    assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: invalid record.`);
    const account = value as Record<string, unknown>;
    assert(Object.keys(account).length === 4 && Object.keys(account).every(key => ["username", "email", "password", "startingFeathers"].includes(key)), `${label}: unexpected fields.`);
    assert(typeof account.username === "string" && canonicalizeUsername(account.username) === account.username, `${label}: invalid canonical username.`);
    assert(typeof account.email === "string" && canonicalizeEmail(account.email) === account.email, `${label}: invalid canonical email.`);
    assert(isValidPassword(account.password), `${label}: invalid password.`);
    assert(Number.isSafeInteger(account.startingFeathers) && (account.startingFeathers as number) > 0 && (account.startingFeathers as number) <= 1000000, `${label}: invalid whole-feather grant.`);
    assert(!usernames.has(account.username) && !emails.has(account.email), `${label}: duplicate identity.`);
    assert(!passwords.has(account.password), `${label}: passwords must be unique.`);
    usernames.add(account.username); emails.add(account.email); passwords.add(account.password);
  }
  return input as Manifest;
}

async function privateJson(filename: string, value: unknown) {
  const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert(!existing || (existing.isFile() && !existing.isSymbolicLink() && existing.nlink === 1 && (existing.mode & 0o077) === 0), "Unsafe results file.");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, filename); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const manifestIndex = args.indexOf("--manifest");
  const apply = args.includes("--apply");
  assert(manifestIndex >= 0 && typeof args[manifestIndex + 1] === "string" && !args[manifestIndex + 1].startsWith("--"), "Usage: --manifest <private-json-file> [--apply]");
  assert(args.length === (apply ? 3 : 2) && args.filter(arg => arg === "--manifest").length === 1 && args.filter(arg => arg === "--apply").length === (apply ? 1 : 0), "Unexpected CLI arguments.");
  const filename = path.resolve(args[manifestIndex + 1]);
  const stat = await lstat(filename);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0, "Manifest must be a private, singly linked regular file (mode 0600).");
  const manifest = validateManifest(JSON.parse(await readFile(filename, "utf8")));
  assert(process.env.DATABASE_PROVIDER === "postgresql", "Provisioning requires explicit PostgreSQL configuration.");
  assert(process.env.APP_URL === manifest.appUrl, "Manifest application origin does not match runtime.");
  assert(process.env.REQUIRE_EMAIL_VERIFICATION !== "true", "Immediate grants require the application's verification gate to be disabled.");
  const { db, requireDatabaseStartup } = await import("../src/lib/db");
  const { registerUser, verifyPassword } = await import("../src/lib/auth");
  const originalGrant = process.env.STARTING_FEATHERS;
  const resultsPath = `${filename}.results.json`;
  const results: { index: number; userId: string; outcome: string; startingFeathers: number }[] = [];
  const persist = (status: string) => privateJson(resultsPath, {
    batchId: manifest.batchId, appUrl: manifest.appUrl, status, updatedAt: new Date().toISOString(),
    requested: manifest.accounts.length, verified: results.length, accounts: results,
  });
  async function verify(account: Account, id: string, newlyCreated = false) {
    await runSerializableTransaction(db, async tx => {
      const user = await tx.user.findUnique({ where: { id } });
      assert(user && user.username === account.username && user.email === account.email && user.role === "USER" && user.status === "ACTIVE", "Account identity or eligibility mismatch.");
      assert(!newlyCreated || user.emailVerifiedAt === null, "New account was unexpectedly marked email-verified.");
      const journal = await tx.journalEntry.findUnique({
        where: { idempotencyScope_idempotencyKey: { idempotencyScope: "WELCOME_GRANT", idempotencyKey: id } },
        include: { postings: { include: { ledgerAccount: true } } },
      });
      const amount = BigInt(account.startingFeathers) * 1000n;
      assert(journal && journal.type === "WELCOME_GRANT" && journal.status === "POSTED" && journal.referenceType === "USER" && journal.referenceId === id && journal.actorUserId === id, "Welcome journal identity mismatch.");
      assert(JSON.parse(journal.metadata).amountMilli === amount.toString(), "Welcome journal amount mismatch.");
      assert(journal.postings.length === 2, "Welcome grant must have exactly two postings.");
      const credit = journal.postings.find(posting => posting.ledgerAccount.ownerType === "USER" && posting.ledgerAccount.ownerId === id && posting.ledgerAccount.purpose === "USER_FEATHERS");
      const debit = journal.postings.find(posting => posting.ledgerAccount.ownerType === "SYSTEM" && posting.ledgerAccount.ownerId === "issuance" && posting.ledgerAccount.purpose === "ISSUANCE");
      assert(credit?.amountMilli === amount && debit?.amountMilli === -amount, "Welcome journal postings mismatch.");
      const wallet = credit.ledgerAccount;
      const postings = await tx.ledgerPosting.findMany({ where: { ledgerAccountId: wallet.id, journalEntry: { status: "POSTED" } }, select: { amountMilli: true } });
      const posted = postings.reduce((sum, entry) => sum + entry.amountMilli, 0n);
      assert(posted === wallet.balanceMilli && wallet.balanceMilli === user.balanceMilli && wallet.balanceMilli >= 0n, "Account wallet reconciliation failed.");
    });
  }
  try {
    await requireDatabaseStartup();
    // Complete collision review before any participant is created. A manifest's
    // password and expected journal amount serve as the durable resume proof.
    const existing = new Map<number, string>();
    for (const [index, account] of manifest.accounts.entries()) {
      const matches = await db.user.findMany({ where: { OR: [{ username: account.username }, { email: account.email }] } });
      if (!matches.length) continue;
      assert(matches.length === 1 && matches[0].username === account.username && matches[0].email === account.email, `Account ${index + 1}: existing identity collision.`);
      assert(await verifyPassword(account.password, matches[0].passwordHash), `Account ${index + 1}: existing credentials do not match this batch.`);
      await verify(account, matches[0].id);
      existing.set(index, matches[0].id);
    }
    console.log(JSON.stringify({ mode: apply ? "apply" : "preview", batchId: manifest.batchId, requested: manifest.accounts.length, newAccounts: manifest.accounts.length - existing.size, resumableAccounts: existing.size, totalStartingFeathers: manifest.accounts.reduce((sum, account) => sum + account.startingFeathers, 0) }));
    if (!apply) return;
    await persist("in_progress");
    for (const [index, account] of manifest.accounts.entries()) {
      let id = existing.get(index);
      const created = !id;
      if (!id) {
        process.env.STARTING_FEATHERS = String(account.startingFeathers);
        const result = await registerUser({ email: account.email, username: account.username, displayName: account.username, password: account.password, userAgent: manifest.batchId });
        id = result.user.id;
        await db.session.deleteMany({ where: { userId: id, tokenHash: sha256(result.session.token), userAgent: manifest.batchId } });
      }
      await verify(account, id, created);
      if (!created) {
        // A process may stop after registration commits but before its returned
        // token is removed. Preflight proved ownership through the manifest's
        // password and grant; clean only this batch's sessions after rechecking
        // its journal. Ordinary login sessions have a different userAgent.
        await db.session.deleteMany({ where: { userId: id, userAgent: manifest.batchId } });
      }
      results.push({ index: index + 1, userId: id, outcome: created ? "created" : "verified_existing", startingFeathers: account.startingFeathers });
      await persist("in_progress");
      if (results.length % 10 === 0) console.log(JSON.stringify({ verified: results.length, requested: manifest.accounts.length }));
    }
    await persist("complete");
    console.log(JSON.stringify({ ok: true, verified: results.length, resultsPath }));
  } catch (error) {
    if (apply) await persist("interrupted").catch(() => undefined);
    throw error;
  } finally {
    if (originalGrant === undefined) delete process.env.STARTING_FEATHERS;
    else process.env.STARTING_FEATHERS = originalGrant;
    await db.$disconnect();
  }
}

main().catch(error => {
  // Driver errors can contain credentials or query parameters. Keep those off stdout/stderr.
  console.error(error instanceof ProvisioningError ? error.message : "Provisioning failed; credentials and driver details suppressed. Inspect private results and retry the same manifest.");
  process.exitCode = 1;
});
