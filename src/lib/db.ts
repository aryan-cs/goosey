import { PrismaClient as SqlitePrismaClient } from "@prisma/client";
import { PrismaClient as PostgresPrismaClient } from "@goosey/postgresql-client";
import { resolveDatabaseRuntime } from "@/lib/database-runtime";
import { verifyPostgresConnection, type PostgresStartupState } from "@/lib/postgres-startup";
import { hardenSqliteConnection, prepareSqliteDatasourceUrl, type SqliteStartupState } from "@/lib/sqlite-startup";

export type DatabaseStartupState = SqliteStartupState | PostgresStartupState;

const globalForPrisma = globalThis as unknown as {
  prisma?: SqlitePrismaClient;
  prismaRuntimeKey?: string;
  prismaStartup?: Promise<DatabaseStartupState>;
};

export const databaseRuntime = resolveDatabaseRuntime();
const datasourceUrl = databaseRuntime.provider === "sqlite"
  ? prepareSqliteDatasourceUrl(databaseRuntime.datasourceUrl)
  : databaseRuntime.datasourceUrl;
const runtimeKey = `${databaseRuntime.provider}:${datasourceUrl}`;

if (globalForPrisma.prismaRuntimeKey && globalForPrisma.prismaRuntimeKey !== runtimeKey) {
  throw new Error("Database runtime configuration changed while Prisma was active; restart the process.");
}

function createClient(): SqlitePrismaClient {
  const options = {
    datasourceUrl,
    log: (process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]) as Array<"error" | "warn">,
  };
  if (databaseRuntime.provider === "postgresql") {
    // CI enforces that both schemas expose the same logical client contract.
    return new PostgresPrismaClient(options) as unknown as SqlitePrismaClient;
  }
  return new SqlitePrismaClient(options);
}

export const db = globalForPrisma.prisma ?? createClient();

export async function requireDatabaseStartup(): Promise<DatabaseStartupState> {
  globalForPrisma.prismaStartup ??= databaseRuntime.provider === "postgresql"
    ? verifyPostgresConnection(db as unknown as PostgresPrismaClient)
    : hardenSqliteConnection(db, datasourceUrl);
  return globalForPrisma.prismaStartup;
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
  globalForPrisma.prismaRuntimeKey = runtimeKey;
}
