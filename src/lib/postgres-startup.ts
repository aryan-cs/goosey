import type { PrismaClient } from "@goosey/postgresql-client";

type PostgresProbeClient = Pick<PrismaClient, "$queryRawUnsafe">;

export type PostgresStartupState = {
  provider: "postgresql";
  database: string;
  user: string;
  serverVersionNum: number;
};

type ProbeRow = {
  database_name: unknown;
  database_user: unknown;
  server_version_num: unknown;
};

export async function verifyPostgresConnection(client: PostgresProbeClient): Promise<PostgresStartupState> {
  const rows = await client.$queryRawUnsafe<ProbeRow[]>(
    "SELECT current_database() AS database_name, current_user AS database_user, current_setting('server_version_num') AS server_version_num",
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("PostgreSQL startup probe returned an unexpected result.");
  }
  const row = rows[0];
  const serverVersionNum = Number(row.server_version_num);
  if (
    typeof row.database_name !== "string" ||
    !row.database_name ||
    typeof row.database_user !== "string" ||
    !row.database_user ||
    !Number.isSafeInteger(serverVersionNum) ||
    serverVersionNum < 140000
  ) {
    throw new Error("PostgreSQL startup probe returned invalid identity or version data.");
  }
  return {
    provider: "postgresql",
    database: row.database_name,
    user: row.database_user,
    serverVersionNum,
  };
}
