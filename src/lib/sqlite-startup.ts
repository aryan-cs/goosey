import type { PrismaClient } from "@prisma/client";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

type SqlitePragmaClient = Pick<PrismaClient, "$queryRawUnsafe">;

export type SqliteStartupState = {
  busyTimeoutMs: number;
  foreignKeys: true;
  journalMode: "wal" | "memory";
  walCompatible: boolean;
};

function splitDatasourceUrl(datasourceUrl: string): { base: string; parameters: URLSearchParams } {
  const separator = datasourceUrl.indexOf("?");
  return {
    base: separator === -1 ? datasourceUrl : datasourceUrl.slice(0, separator),
    parameters: new URLSearchParams(separator === -1 ? "" : datasourceUrl.slice(separator + 1)),
  };
}

export function prepareSqliteDatasourceUrl(datasourceUrl: string | undefined): string {
  if (!datasourceUrl?.startsWith("file:")) {
    throw new Error("Goosey's local runtime requires a file: SQLite DATABASE_URL.");
  }

  const { base, parameters } = splitDatasourceUrl(datasourceUrl);
  if (base === "file:") throw new Error("SQLite DATABASE_URL must name a database file or an in-memory database.");

  const configuredConnectionLimit = parameters.get("connection_limit");
  if (configuredConnectionLimit !== null && configuredConnectionLimit !== "1") {
    throw new Error("SQLite connection_limit must be 1 so connection-local safety pragmas apply to every query.");
  }
  parameters.set("connection_limit", "1");

  const query = parameters.toString();
  return query.length === 0 ? base : `${base}?${query}`;
}

function isInMemoryDatasource(datasourceUrl: string): boolean {
  const { base, parameters } = splitDatasourceUrl(datasourceUrl);
  return base === "file::memory:" || parameters.get("mode") === "memory";
}

function pragmaInteger(rows: unknown, key: string): number {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error(`SQLite PRAGMA ${key} returned an unexpected result.`);
  }
  const value = (rows[0] as Record<string, unknown>)[key];
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new Error(`SQLite PRAGMA ${key} returned an invalid value.`);
  }
  return parsed;
}

function pragmaString(rows: unknown, key: string): string {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error(`SQLite PRAGMA ${key} returned an unexpected result.`);
  }
  const value = (rows[0] as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`SQLite PRAGMA ${key} returned an invalid value.`);
  return value.toLowerCase();
}

export async function hardenSqliteConnection(
  client: SqlitePragmaClient,
  datasourceUrl: string,
): Promise<SqliteStartupState> {
  const hardenedUrl = prepareSqliteDatasourceUrl(datasourceUrl);
  const declaredInMemory = isInMemoryDatasource(hardenedUrl);

  await client.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await client.$queryRawUnsafe(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  await client.$queryRawUnsafe<unknown[]>("PRAGMA journal_mode = WAL");

  const foreignKeys = pragmaInteger(await client.$queryRawUnsafe<unknown[]>("PRAGMA foreign_keys"), "foreign_keys");
  const busyTimeoutMs = pragmaInteger(
    await client.$queryRawUnsafe<unknown[]>("PRAGMA busy_timeout"),
    "timeout",
  );
  const journalMode = pragmaString(
    await client.$queryRawUnsafe<unknown[]>("PRAGMA journal_mode"),
    "journal_mode",
  );

  if (foreignKeys !== 1) throw new Error("SQLite startup refused: foreign key enforcement is disabled.");
  if (busyTimeoutMs < SQLITE_BUSY_TIMEOUT_MS) {
    throw new Error(`SQLite startup refused: busy_timeout is ${busyTimeoutMs}ms; at least ${SQLITE_BUSY_TIMEOUT_MS}ms is required.`);
  }
  if (journalMode !== "wal" && !(declaredInMemory && journalMode === "memory")) {
    throw new Error(`SQLite startup refused: file-backed database journal_mode is ${journalMode}, not WAL.`);
  }

  return {
    busyTimeoutMs,
    foreignKeys: true,
    journalMode: journalMode as "wal" | "memory",
    walCompatible: journalMode === "wal",
  };
}
