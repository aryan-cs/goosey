import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  hardenSqliteConnection,
  prepareSqliteDatasourceUrl,
  SQLITE_BUSY_TIMEOUT_MS,
} from "@/lib/sqlite-startup";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((operation) => operation()));
});

describe("prepareSqliteDatasourceUrl", () => {
  it("forces a single connection while preserving SQLite URL parameters", () => {
    expect(prepareSqliteDatasourceUrl("file:./example.db?socket_timeout=7")).toBe(
      "file:./example.db?socket_timeout=7&connection_limit=1",
    );
    expect(prepareSqliteDatasourceUrl("file:./example.db?connection_limit=1")).toBe(
      "file:./example.db?connection_limit=1",
    );
  });

  it("rejects non-SQLite, empty, and multi-connection runtime URLs", () => {
    expect(() => prepareSqliteDatasourceUrl(undefined)).toThrow(/requires a file: SQLite/);
    expect(() => prepareSqliteDatasourceUrl("postgresql://localhost/goosey")).toThrow(/requires a file: SQLite/);
    expect(() => prepareSqliteDatasourceUrl("file:")).toThrow(/must name a database/);
    expect(() => prepareSqliteDatasourceUrl("file:./example.db?connection_limit=2")).toThrow(/must be 1/);
  });
});

describe("hardenSqliteConnection", () => {
  it("enables and verifies foreign keys, busy timeout, and WAL on a disposable file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "goosey-sqlite-startup-"));
    cleanup.push(() => rm(directory, { force: true, recursive: true }));
    const datasourceUrl = prepareSqliteDatasourceUrl(`file:${join(directory, "runtime.db")}`);
    const client = new PrismaClient({ datasourceUrl });
    cleanup.push(() => client.$disconnect());

    const state = await hardenSqliteConnection(client, datasourceUrl);

    expect(state).toEqual({
      busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
      foreignKeys: true,
      journalMode: "wal",
      walCompatible: true,
    });
    expect(await client.$queryRawUnsafe("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1n }]);
    expect(await client.$queryRawUnsafe("PRAGMA busy_timeout")).toEqual([{ timeout: BigInt(SQLITE_BUSY_TIMEOUT_MS) }]);
    expect(await client.$queryRawUnsafe("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
  });

  it("accepts MEMORY journal mode only when the datasource declares in-memory mode", async () => {
    const responses = new Map<string, unknown>([
      ["PRAGMA journal_mode", [{ journal_mode: "memory" }]],
      ["PRAGMA foreign_keys", [{ foreign_keys: 1n }]],
      ["PRAGMA busy_timeout", [{ timeout: BigInt(SQLITE_BUSY_TIMEOUT_MS) }]],
    ]);
    const client = {
      $queryRawUnsafe: async (query: string) => responses.get(query) ?? [],
    } as Pick<PrismaClient, "$queryRawUnsafe">;

    await expect(hardenSqliteConnection(client, "file:ephemeral?mode=memory")).resolves.toMatchObject({
      journalMode: "memory",
      walCompatible: false,
    });
  });

  it("fails closed when verification reports unsafe effective settings", async () => {
    const responses = new Map<string, unknown>([
      ["PRAGMA journal_mode", [{ journal_mode: "delete" }]],
      ["PRAGMA foreign_keys", [{ foreign_keys: 1n }]],
      ["PRAGMA busy_timeout", [{ timeout: BigInt(SQLITE_BUSY_TIMEOUT_MS) }]],
    ]);
    const client = {
      $queryRawUnsafe: async (query: string) => responses.get(query) ?? [],
    } as Pick<PrismaClient, "$queryRawUnsafe">;

    await expect(hardenSqliteConnection(client, "file:./unsafe.db")).rejects.toThrow(
      /journal_mode is delete, not WAL/,
    );
  });

  it.each([
    {
      expected: /foreign key enforcement is disabled/,
      foreignKeys: 0n,
      timeout: BigInt(SQLITE_BUSY_TIMEOUT_MS),
    },
    {
      expected: /busy_timeout is 4999ms/,
      foreignKeys: 1n,
      timeout: BigInt(SQLITE_BUSY_TIMEOUT_MS - 1),
    },
  ])("fails closed when a connection-local pragma is unsafe", async ({ expected, foreignKeys, timeout }) => {
    const responses = new Map<string, unknown>([
      ["PRAGMA journal_mode", [{ journal_mode: "wal" }]],
      ["PRAGMA foreign_keys", [{ foreign_keys: foreignKeys }]],
      ["PRAGMA busy_timeout", [{ timeout }]],
    ]);
    const client = {
      $queryRawUnsafe: async (query: string) => responses.get(query) ?? [],
    } as Pick<PrismaClient, "$queryRawUnsafe">;

    await expect(hardenSqliteConnection(client, "file:./unsafe.db")).rejects.toThrow(expected);
  });
});
