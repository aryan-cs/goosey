import { describe, expect, it } from "vitest";
import { validatePostgresDeploymentEnvironment } from "./postgres-deployment-env";

const valid = {
  POSTGRES_DATABASE_URL: "postgresql://app:secret@db.example.com/goosey?sslmode=require&pgbouncer=true",
  POSTGRES_DIRECT_DATABASE_URL: "postgresql://migrator:secret@primary.example.com/goosey?sslmode=verify-full",
  NODE_ENV: "production",
};

describe("PostgreSQL deployment environment", () => {
  it("accepts separate secure runtime and migration URLs", () => {
    expect(() => validatePostgresDeploymentEnvironment(valid)).not.toThrow();
  });

  it("requires both PostgreSQL URLs with a host and database", () => {
    expect(() => validatePostgresDeploymentEnvironment({})).toThrow(/POSTGRES_DATABASE_URL is required/);
    expect(() => validatePostgresDeploymentEnvironment({ ...valid, POSTGRES_DIRECT_DATABASE_URL: "file:db" })).toThrow(/must use postgresql/);
    expect(() => validatePostgresDeploymentEnvironment({ ...valid, POSTGRES_DIRECT_DATABASE_URL: "postgresql://db.example.com" })).toThrow(/database name/);
  });

  it("rejects a pooled direct migration connection", () => {
    expect(() => validatePostgresDeploymentEnvironment({
      ...valid,
      POSTGRES_DIRECT_DATABASE_URL: "postgresql://db.example.com/goosey?sslmode=require&pgbouncer=true",
    })).toThrow(/must bypass PgBouncer/);
  });

  it("requires transport security for non-loopback production databases", () => {
    expect(() => validatePostgresDeploymentEnvironment({
      ...valid,
      POSTGRES_DATABASE_URL: "postgresql://db.example.com/goosey?sslmode=disable",
    })).toThrow(/must set sslmode/);
    expect(() => validatePostgresDeploymentEnvironment({
      ...valid,
      POSTGRES_DIRECT_DATABASE_URL: "postgresql://db.example.com/goosey",
    })).toThrow(/must set sslmode/);
  });

  it("permits loopback URLs for credential-free local and CI rehearsal", () => {
    expect(() => validatePostgresDeploymentEnvironment({
      POSTGRES_DATABASE_URL: "postgresql://goosey:goosey@127.0.0.1:5432/goosey",
      POSTGRES_DIRECT_DATABASE_URL: "postgresql://goosey:goosey@localhost:5432/goosey",
      NODE_ENV: "production",
    })).not.toThrow();
  });
});
