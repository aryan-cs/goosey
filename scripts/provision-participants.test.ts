import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const password = "provision-validation-private-password";
function manifest() {
  return {
    batchId: "provision-validation-batch",
    appUrl: "https://getgoosey.vercel.app",
    accounts: [{ username: "provisionperson", email: "provisionperson@gmail.com", password, startingFeathers: 1000 }],
  };
}
async function fixture(value: unknown = manifest()) {
  const directory = await mkdtemp(join(tmpdir(), "goosey-provision-validation-"));
  directories.push(directory);
  const filename = join(directory, "manifest.json");
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  return { filename, directory };
}
function rejects(args: string[], message: string, overrides: Partial<NodeJS.ProcessEnv> = {}) {
  // Deliberately omit all inherited database URLs and secrets. security.ts
  // imports the lazy Prisma constructor, so PostgreSQL cases provide an unused
  // localhost address. Every case rejects before startup or any database query.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", ...overrides };
  if (overrides.DATABASE_PROVIDER === "postgresql") {
    env.POSTGRES_DATABASE_URL = "postgresql://unused:unused@127.0.0.1:9/unused?sslmode=require";
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/provision-participants.ts"), ...args], {
    cwd: process.cwd(), env, encoding: "utf8", timeout: 10000, maxBuffer: 65536,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(password);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("participant provisioning CLI preflight without a database", () => {
  it("rejects absent arguments and unknown or repeated switches", async () => {
    const { filename } = await fixture();
    rejects([], "Usage:");
    rejects(["--manifest", "--apply"], "Usage:");
    rejects(["--manifest", filename, "--unexpected"], "Unexpected CLI arguments.");
    rejects(["--manifest", filename, "--apply", "--apply"], "Unexpected CLI arguments.");
    rejects(["--manifest", filename, "--manifest", filename], "Unexpected CLI arguments.");
  });
  it("requires PostgreSQL and an exact matching origin before database startup", async () => {
    const { filename } = await fixture();
    rejects(["--manifest", filename], "requires explicit PostgreSQL");
    rejects(["--manifest", filename, "--apply"], "requires explicit PostgreSQL", { DATABASE_PROVIDER: "sqlite" });
    rejects(["--manifest", filename], "origin does not match runtime", { DATABASE_PROVIDER: "postgresql", APP_URL: "https://other.example" });
    rejects(["--manifest", filename], "verification gate to be disabled", { DATABASE_PROVIDER: "postgresql", APP_URL: manifest().appUrl, REQUIRE_EMAIL_VERIFICATION: "true" });
  });
  it("rejects public-readable credentials and symbolic links", async () => {
    const { filename, directory } = await fixture();
    await chmod(filename, 0o644);
    rejects(["--manifest", filename], "Manifest must be a private");
    await chmod(filename, 0o600);
    const link = join(directory, "linked.json");
    await symlink(filename, link);
    rejects(["--manifest", link], "Manifest must be a private");
  });
  it.each([
    ["duplicate identity", (input: ReturnType<typeof manifest>) => { input.accounts.push({ ...input.accounts[0] }); }, "duplicate identity"],
    ["duplicate password", (input: ReturnType<typeof manifest>) => { input.accounts.push({ ...input.accounts[0], username: "secondperson", email: "secondperson@gmail.com" }); }, "passwords must be unique"],
    ["noncanonical username", (input: ReturnType<typeof manifest>) => { input.accounts[0].username = "MixedCase"; }, "invalid canonical username"],
    ["noncanonical email", (input: ReturnType<typeof manifest>) => { input.accounts[0].email = "MixedCase@gmail.com"; }, "invalid canonical email"],
    ["short password", (input: ReturnType<typeof manifest>) => { input.accounts[0].password = "short"; }, "invalid password"],
    ["zero grant", (input: ReturnType<typeof manifest>) => { input.accounts[0].startingFeathers = 0; }, "invalid whole-feather grant"],
    ["fractional grant", (input: ReturnType<typeof manifest>) => { input.accounts[0].startingFeathers = 1.5; }, "invalid whole-feather grant"],
    ["oversized grant", (input: ReturnType<typeof manifest>) => { input.accounts[0].startingFeathers = 1000001; }, "invalid whole-feather grant"],
    ["empty accounts", (input: ReturnType<typeof manifest>) => { input.accounts = []; }, "Invalid account count"],
    ["insecure origin", (input: ReturnType<typeof manifest>) => { input.appUrl = "http://example.com"; }, "exact HTTPS origin"],
    ["origin with path", (input: ReturnType<typeof manifest>) => { input.appUrl += "/path"; }, "exact HTTPS origin"],
  ])("rejects %s", async (_name, mutate, message) => {
    const value = manifest();
    mutate(value);
    const { filename } = await fixture(value);
    rejects(["--manifest", filename], message);
  });
  it("rejects extra manifest and account fields", async () => {
    const extraTop = await fixture({ ...manifest(), destination: "hidden" });
    rejects(["--manifest", extraTop.filename], "Unknown manifest field");
    const extraAccount = await fixture({ ...manifest(), accounts: [{ ...manifest().accounts[0], role: "ADMIN" }] });
    rejects(["--manifest", extraAccount.filename], "unexpected fields");
  });
});
