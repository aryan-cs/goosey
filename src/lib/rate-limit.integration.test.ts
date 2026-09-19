import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("persisted request limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-rate-limit-"));
  const db = new PrismaClient({ datasourceUrl: `file:${join(directory, "limits.db")}?connection_limit=1` });
  let enforceRateLimit: typeof import("./security").enforceRateLimit;

  beforeAll(async () => {
    await db.$executeRawUnsafe(`CREATE TABLE "RateLimitBucket" (
      "key" TEXT NOT NULL PRIMARY KEY,
      "points" INTEGER NOT NULL,
      "resetAt" DATETIME NOT NULL,
      "updatedAt" DATETIME NOT NULL
    )`);
    vi.doMock("@/lib/db", () => ({ db }));
    ({ enforceRateLimit } = await import("./security"));
  });

  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    vi.doUnmock("@/lib/db");
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("permits exactly the configured number of requests without incrementing rejected attempts", async () => {
    await enforceRateLimit("threshold", 2, 60_000);
    await enforceRateLimit("threshold", 2, 60_000);
    await expect(enforceRateLimit("threshold", 2, 60_000)).rejects.toMatchObject({ name: "RateLimitError" });
    expect((await db.rateLimitBucket.findUniqueOrThrow({ where: { key: "threshold" } })).points).toBe(2);
  });

  it("resets at the window boundary and rounds retry seconds up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(start);
    await enforceRateLimit("window", 1, 1_500);
    await expect(enforceRateLimit("window", 1, 1_500)).rejects.toMatchObject({ retryAfterSeconds: 2 });
    vi.setSystemTime(new Date(start.getTime() + 1_500));
    await enforceRateLimit("window", 1, 1_500);
    expect(await db.rateLimitBucket.findUniqueOrThrow({ where: { key: "window" } })).toMatchObject({
      points: 1,
      resetAt: new Date(start.getTime() + 3_000),
    });
  });

  it("keeps different identities independent", async () => {
    await enforceRateLimit("identity-a", 1, 60_000);
    await expect(enforceRateLimit("identity-a", 1, 60_000)).rejects.toMatchObject({ name: "RateLimitError" });
    await expect(enforceRateLimit("identity-b", 1, 60_000)).resolves.toBeUndefined();
  });

  it("does not exceed the limit for concurrent calls through the SQLite connection", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => enforceRateLimit("parallel", 3, 60_000)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ name: "RateLimitError" });
    }
    expect((await db.rateLimitBucket.findUniqueOrThrow({ where: { key: "parallel" } })).points).toBe(3);
  });

  it("rejects invalid configuration before persisting a bucket", async () => {
    for (const [limit, window] of [[0, 1000], [1.5, 1000], [1, 0], [1, Infinity]]) {
      await expect(enforceRateLimit("invalid", limit, window)).rejects.toThrow("Invalid rate-limit configuration");
    }
    expect(await db.rateLimitBucket.findUnique({ where: { key: "invalid" } })).toBeNull();
  });
});
