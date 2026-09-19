import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSandboxLock, assertDevelopmentOnly, ensureSandboxPaths, readSandboxManifest, sandboxEnvironment, sandboxPaths } from "./development-sandbox";
import { buildDevelopmentScenarios } from "./development-scenarios";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "goosey-synthetic-test-"));
  directories.push(root);
  return root;
}

describe("development sandbox isolation", () => {
  it.each(["../dev", "/tmp/live", "team/../../prisma", "team?mode=rw", "", "TEAM"])("rejects path-like dataset name %s", name => {
    expect(() => sandboxPaths("/project", name)).toThrow();
  });
  it.each([{ NODE_ENV: "production" }, { NODE_ENV: "test", VERCEL: "1" }, { NODE_ENV: "test", RENDER: "true" }, { NODE_ENV: "test", FLY_APP_NAME: "goosey" }] satisfies NodeJS.ProcessEnv[])("refuses hosted/production environment %j", env => {
    expect(() => assertDevelopmentOnly(env)).toThrow();
  });
  it("rejects a linked dataset before touching its external target", async () => {
    const root = await fixture();
    const paths = await ensureSandboxPaths(root, "team");
    const outside = path.join(root, "live");
    await mkdir(outside);
    await writeFile(path.join(outside, "data.sqlite"), "must survive");
    await symlink(outside, paths.directory);
    await expect(ensureSandboxPaths(root, "team")).rejects.toThrow(/symlink/);
    expect(await readFile(path.join(outside, "data.sqlite"), "utf8")).toBe("must survive");
  });
  it("requires ownership marker and rejects an active server lock", async () => {
    const root = await fixture();
    const paths = await ensureSandboxPaths(root, "team");
    await mkdir(paths.directory);
    await writeFile(paths.manifest, '{"kind":"live-database"}');
    await expect(readSandboxManifest(paths.manifest)).rejects.toThrow(/ownership/);
    const unlock = await acquireSandboxLock(paths.lock);
    await expect(acquireSandboxLock(paths.lock)).rejects.toThrow(/in use/);
    await unlock();
    const secondUnlock = await acquireSandboxLock(paths.lock);
    await secondUnlock();
  });
  it("uses only the dedicated local database and disables outbound email", () => {
    const env = sandboxEnvironment("/project/output/development-sandbox/team/data.sqlite", "test-secret");
    expect(env.DATABASE_URL).toBe("file:/project/output/development-sandbox/team/data.sqlite?connection_limit=1");
    expect(env.DATABASE_PROVIDER).toBe("sqlite");
    expect(env.POSTGRES_DATABASE_URL).toBe("");
    expect(env.SMTP_HOST).toBe("");
    expect(env.SESSION_COOKIE_NAME).toBe("goosey_sandbox_session");
  });
});

describe("historical development scenarios", () => {
  const asOf = new Date("2026-09-19T12:00:00.000Z");
  it("is deterministic and covers market lifecycles with coherent timelines", () => {
    const plan = buildDevelopmentScenarios({ asOf, seed: 42 });
    expect(plan).toEqual(buildDevelopmentScenarios({ asOf, seed: 42 }));
    expect(plan).not.toEqual(buildDevelopmentScenarios({ asOf, seed: 43 }));
    expect(new Set(plan.markets.map(m => m.finalStatus))).toEqual(new Set(["OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOID", "DRAFT"]));
    expect(Math.min(...plan.markets.map(m => m.openedAt.getTime()))).toBe(asOf.getTime() - 90 * 86_400_000);
    for (const market of plan.markets) {
      expect(market.openedAt < market.closesAt && market.closesAt <= market.resolvesAt).toBe(true);
      const event = plan.events.find(e => e.slug === market.eventSlug)!;
      expect(event.startsAt <= market.openedAt && event.endsAt >= market.resolvesAt).toBe(true);
      if (market.resolvedAt) expect(market.resolvedAt >= market.resolvesAt && market.resolvedAt <= asOf).toBe(true);
      let prior = market.openedAt.getTime();
      for (const intent of market.tradeIntents) {
        expect(intent.at.getTime()).toBeGreaterThan(prior);
        expect(intent.at < market.closesAt && intent.at <= asOf).toBe(true);
        expect(intent.targetProbability).toBeGreaterThan(0);
        expect(intent.targetProbability).toBeLessThan(1);
        expect(intent.participantIndex).toBeLessThan(24);
        prior = intent.at.getTime();
      }
      if (market.finalStatus === "OPEN") {
        expect(market.tradeIntents.filter(t => t.at.getTime() > asOf.getTime() - 3_600_000).length).toBeGreaterThan(40);
      }
    }
  });
});
