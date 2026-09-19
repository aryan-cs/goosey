export type PostgresDeploymentEnvironment = {
  POSTGRES_DATABASE_URL?: string;
  POSTGRES_DIRECT_DATABASE_URL?: string;
  NODE_ENV?: string;
};

const SECURE_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

function parsePostgresUrl(name: string, value: string | undefined): URL {
  if (!value) throw new Error(`${name} is required for PostgreSQL migration deployment`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use postgresql:// or postgres://`);
  }
  if (!url.hostname || !url.pathname || url.pathname === "/") {
    throw new Error(`${name} must include a host and database name`);
  }
  if (url.hash) throw new Error(`${name} must not contain a URL fragment`);
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function validatePostgresDeploymentEnvironment(env: PostgresDeploymentEnvironment): void {
  const runtimeUrl = parsePostgresUrl("POSTGRES_DATABASE_URL", env.POSTGRES_DATABASE_URL);
  const directUrl = parsePostgresUrl("POSTGRES_DIRECT_DATABASE_URL", env.POSTGRES_DIRECT_DATABASE_URL);

  if (directUrl.searchParams.get("pgbouncer")?.toLowerCase() === "true") {
    throw new Error("POSTGRES_DIRECT_DATABASE_URL must bypass PgBouncer for Prisma migrations");
  }

  if (env.NODE_ENV === "production") {
    for (const [name, url] of [
      ["POSTGRES_DATABASE_URL", runtimeUrl],
      ["POSTGRES_DIRECT_DATABASE_URL", directUrl],
    ] as const) {
      if (isLoopback(url.hostname)) continue;
      const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
      if (!sslMode || !SECURE_SSL_MODES.has(sslMode)) {
        throw new Error(`${name} must set sslmode=require, verify-ca, or verify-full in production`);
      }
    }
  }
}
