import { describe, expect, it } from "vitest";
import { resolveDatabaseRuntime } from "./database-runtime";

describe("database runtime provider contract", () => {
  it("supports protected Neon integration URLs without changing provider or TLS requirements", () => {
    const env = { DATABASE_PROVIDER: "postgresql", NODE_ENV: "production", NEON_DATABASE_URL: "postgresql://app:secret@db.example.com/goosey?sslmode=require" };
    expect(resolveDatabaseRuntime(env).datasourceUrl).toBe(env.NEON_DATABASE_URL);
    expect(() => resolveDatabaseRuntime({ ...env, NEON_DATABASE_URL: "postgresql://db.example.com/goosey" })).toThrow(/must set sslmode/);
    expect(() => resolveDatabaseRuntime({ ...env, POSTGRES_DATABASE_URL: "invalid" })).toThrow(/valid PostgreSQL/);
    expect(() => resolveDatabaseRuntime({ ...env, DATABASE_PROVIDER: undefined })).toThrow(/explicitly set/);
  });
  it("preserves SQLite as the non-production default", () => {
    expect(resolveDatabaseRuntime({ DATABASE_URL: "file:./dev.db", NODE_ENV: "development" })).toEqual({
      provider: "sqlite",
      datasourceUrl: "file:./dev.db",
    });
  });

  it("requires an explicit provider in production", () => {
    expect(() => resolveDatabaseRuntime({ DATABASE_URL: "file:./dev.db", NODE_ENV: "production" })).toThrow(
      /DATABASE_PROVIDER must be explicitly set/,
    );
  });

  it("selects PostgreSQL only from an explicit PostgreSQL URL", () => {
    expect(resolveDatabaseRuntime({
      DATABASE_PROVIDER: "postgresql",
      DATABASE_URL: "file:./dev.db",
      POSTGRES_DATABASE_URL: "postgresql://app:secret@db.example.com/goosey?sslmode=require",
      NODE_ENV: "production",
    })).toEqual({
      provider: "postgresql",
      datasourceUrl: "postgresql://app:secret@db.example.com/goosey?sslmode=require",
    });
  });

  it("fails closed on provider and URL mismatches", () => {
    expect(() => resolveDatabaseRuntime({
      DATABASE_PROVIDER: "sqlite",
      DATABASE_URL: "postgresql://db/goosey",
      NODE_ENV: "development",
    })).toThrow(/requires a file:/);
    expect(() => resolveDatabaseRuntime({
      DATABASE_PROVIDER: "postgresql",
      POSTGRES_DATABASE_URL: "file:./dev.db",
      NODE_ENV: "development",
    })).toThrow(/must use postgresql/);
    expect(() => resolveDatabaseRuntime({
      DATABASE_PROVIDER: "mysql" as "sqlite",
      DATABASE_URL: "file:./dev.db",
      NODE_ENV: "development",
    })).toThrow(/must be explicitly set/);
    expect(() => resolveDatabaseRuntime({
      DATABASE_PROVIDER: "postgresql",
      POSTGRES_DATABASE_URL: "postgresql://app:secret@db.example.com/goosey?sslmode=disable",
      NODE_ENV: "production",
    })).toThrow(/must set sslmode/);
  });
});
