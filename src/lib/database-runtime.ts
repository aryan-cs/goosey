export type DatabaseProvider = "postgresql" | "sqlite";

export type DatabaseRuntimeConfig = {
  provider: DatabaseProvider;
  datasourceUrl: string;
};

const SECURE_SSL_MODES = new Set(["require", "verify-ca", "verify-full"]);

function postgresUrl(value: string | undefined, name: string, production: boolean): string {
  if (!value) throw new Error(`${name} is required when DATABASE_PROVIDER=postgresql.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(`${name} must use postgresql:// or postgres://.`);
  }
  if (!parsed.hostname || parsed.pathname === "/" || !parsed.pathname) {
    throw new Error(`${name} must include a host and database name.`);
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
  if (production && !loopback && (!sslMode || !SECURE_SSL_MODES.has(sslMode))) {
    throw new Error(`${name} must set sslmode=require, verify-ca, or verify-full in production.`);
  }
  return value;
}

export function resolveDatabaseRuntime(
  env: Record<string, string | undefined> = process.env,
): DatabaseRuntimeConfig {
  const declared = env.DATABASE_PROVIDER;
  const provider = declared ?? (env.NODE_ENV === "production" ? undefined : "sqlite");
  if (provider !== "sqlite" && provider !== "postgresql") {
    throw new Error("DATABASE_PROVIDER must be explicitly set to sqlite or postgresql in production.");
  }

  if (provider === "sqlite") {
    if (env.POSTGRES_DATABASE_URL && /^postgres(?:ql)?:\/\//i.test(env.POSTGRES_DATABASE_URL)) {
      throw new Error("DATABASE_PROVIDER=sqlite cannot use POSTGRES_DATABASE_URL as the runtime database.");
    }
    if (!env.DATABASE_URL?.startsWith("file:")) {
      throw new Error("DATABASE_PROVIDER=sqlite requires a file: DATABASE_URL.");
    }
    return { provider, datasourceUrl: env.DATABASE_URL };
  }

  if (env.DATABASE_URL && !env.DATABASE_URL.startsWith("file:")) {
    throw new Error("PostgreSQL runtime selection uses POSTGRES_DATABASE_URL; DATABASE_URL must remain SQLite-only or be unset.");
  }
  return {
    provider,
    datasourceUrl: postgresUrl(
      env.POSTGRES_DATABASE_URL,
      "POSTGRES_DATABASE_URL",
      env.NODE_ENV === "production",
    ),
  };
}
