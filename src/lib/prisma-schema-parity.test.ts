import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { comparePrismaSchemas } from "../../scripts/check-prisma-schema-parity";

const sqlite = (body: string) => `
generator client { provider = "prisma-client-js" }
datasource db { provider = "sqlite" url = env("DATABASE_URL") }
${body}
`;

const postgres = (body: string) => `
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql" url = env("POSTGRES_DATABASE_URL") }
${body}
`;

describe("Prisma logical schema parity", () => {
  it("keeps the checked-in SQLite and PostgreSQL schemas logically identical", async () => {
    const [sqliteSource, postgresSource] = await Promise.all([
      readFile("prisma/schema.prisma", "utf8"),
      readFile("prisma/postgresql/schema.prisma", "utf8"),
    ]);
    expect(comparePrismaSchemas(sqliteSource, postgresSource)).toEqual({ ok: true, differences: [] });
  });

  it("allows only Timestamptz(3) on PostgreSQL DateTime fields", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
        createdAt DateTime
        expiresAt DateTime?
      }`),
      postgres(`model Thing {
        id String @id
        createdAt DateTime @db.Timestamptz(3)
        expiresAt DateTime? @db.Timestamptz(3)
      }`),
    );
    expect(result).toEqual({ ok: true, differences: [] });
  });

  it("rejects a PostgreSQL DateTime field without Timestamptz(3)", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
        createdAt DateTime
      }`),
      postgres(`model Thing {
        id String @id
        createdAt DateTime
      }`),
    );
    expect(result).toEqual({
      ok: false,
      differences: [
        "PostgreSQL DateTime field must declare @db.Timestamptz(3): createdAt DateTime",
      ],
    });
  });

  it("rejects field, relation, and index drift", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
        ownerId String
        @@index([ownerId])
      }`),
      postgres(`model Thing {
        id String @id
        ownerId String?
        @@unique([ownerId])
      }`),
    );
    expect(result.ok).toBe(false);
    expect(result.differences.join("\n")).toContain("model Thing differs");
  });

  it("rejects non-allowlisted PostgreSQL native types", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
        label String
      }`),
      postgres(`model Thing {
        id String @id
        label String @db.VarChar(100)
      }`),
    );
    expect(result).toEqual({
      ok: false,
      differences: ["PostgreSQL native type is not allowlisted: @db.VarChar(100)"],
    });
  });

  it("rejects the timestamp annotation on a non-DateTime field", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
        sequence BigInt
      }`),
      postgres(`model Thing {
        id String @id
        sequence BigInt @db.Timestamptz(3)
      }`),
    );
    expect(result.ok).toBe(false);
    expect(result.differences[0]).toContain("only allowed on DateTime fields");
  });

  it("requires the expected provider on both sides", () => {
    const result = comparePrismaSchemas(
      sqlite(`model Thing {
        id String @id
      }`),
      sqlite(`model Thing {
        id String @id
      }`),
    );
    expect(result.ok).toBe(false);
    expect(result.differences[0]).toContain('must be "postgresql"');
  });
});
