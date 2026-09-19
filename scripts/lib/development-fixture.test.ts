import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { PUBLIC_FIXTURE_MODELS, decodeFixtureRow, encodeFixtureRow } from "./development-fixture";

const instant = new Date("2026-09-19T12:34:56.789Z");

// Full scalar records keep these checks independent of optional-field defaults.
function scalarRow(modelName: string): Record<string, unknown> {
  const model = Prisma.dmmf.datamodel.models.find(model => model.name === modelName)!;
  return Object.fromEntries(model.fields.filter(field => field.kind === "scalar").map(field => {
    if (!field.isRequired) return [field.name, null];
    switch (field.type) {
      case "DateTime": return [field.name, new Date(instant)];
      case "BigInt": return [field.name, 9_007_199_254_740_993n];
      case "Int": return [field.name, 1];
      case "Float": return [field.name, .5];
      case "Boolean": return [field.name, true];
      default: return [field.name, `${modelName}-${field.name}`];
    }
  }));
}

describe("public development fixture serialization", () => {
  it("preserves financial integers beyond JavaScript number precision through JSON", () => {
    const source = { ...scalarRow("LedgerPosting"), amountMilli: -9_007_199_254_740_993n };
    const encoded = encodeFixtureRow("LedgerPosting", source);
    expect(encoded.amountMilli).toBe("-9007199254740993");
    expect(encoded.createdAt).toBe(instant.toISOString());
    const decoded = decodeFixtureRow("LedgerPosting", JSON.parse(JSON.stringify(encoded)));
    expect(decoded.amountMilli).toBe(source.amountMilli);
    expect(decoded.createdAt).toEqual(instant);
  });

  it("omits password hashes instead of shipping shared usable credentials", () => {
    const encoded = encodeFixtureRow("User", { ...scalarRow("User"), passwordHash: "private-password-hash" });
    expect(encoded).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(encoded)).not.toContain("private-password-hash");
    expect(() => decodeFixtureRow("User", { ...encoded, passwordHash: "injected-hash" })).toThrow();
  });

  it("strips free-form journal metadata and settlement worker lease secrets", () => {
    const journal = encodeFixtureRow("JournalEntry", { ...scalarRow("JournalEntry"), metadata: '{"token":"private-token","email":"personal@example.com"}' });
    expect(journal.metadata).toBe("{}");
    const run = encodeFixtureRow("MarketSettlementRun", {
      ...scalarRow("MarketSettlementRun"), claimToken: "private-claim", leaseExpiresAt: instant, lastError: "private-db-url",
    });
    expect(run.claimToken).toBeNull();
    expect(run.leaseExpiresAt).toBeNull();
    expect(run.lastError).toBeNull();
    expect(JSON.stringify([journal, run])).not.toContain("private-");
  });

  it("rejects unredacted journal metadata supplied in an edited fixture", () => {
    const journal = encodeFixtureRow("JournalEntry", scalarRow("JournalEntry"));
    expect(() => decodeFixtureRow("JournalEntry", journal)).not.toThrow();
    expect(() => decodeFixtureRow("JournalEntry", { ...journal, metadata: '{"token":"injected-secret"}' })).toThrow();
  });

  it.each([
    { claimToken: "injected-claim" },
    { leaseExpiresAt: instant.toISOString() },
    { lastError: "postgresql://private-credentials" },
    { status: "PROCESSING" },
  ])("rejects imported settlement operational state %j", injected => {
    const run = encodeFixtureRow("MarketSettlementRun", { ...scalarRow("MarketSettlementRun"), status: "COMPLETED" });
    expect(() => decodeFixtureRow("MarketSettlementRun", run)).not.toThrow();
    expect(() => decodeFixtureRow("MarketSettlementRun", { ...run, ...injected })).toThrow();
  });

  it.each(["Session", "AccountToken", "RegistrationInvite", "RegistrationInviteClaim", "IdempotencyRequest", "TradeQuote", "RateLimitBucket", "WorkerState", "AuditLog", "OrderCommand", "MarketEventCreationRequest"])("excludes operational or private model %s", model => {
    expect(PUBLIC_FIXTURE_MODELS as readonly string[]).not.toContain(model);
    expect(() => encodeFixtureRow(model, {})).toThrow();
    expect(() => decodeFixtureRow(model, {})).toThrow();
  });

  it("rejects unknown import models and scalar fields", () => {
    expect(() => decodeFixtureRow("UnknownModel", {})).toThrow();
    const row = encodeFixtureRow("User", scalarRow("User"));
    expect(() => decodeFixtureRow("User", { ...row, sessionToken: "injected-secret" })).toThrow();
    expect(() => decodeFixtureRow("User", { ...row, sessions: [] })).toThrow();
  });

  it("rebases history and future deadlines together while preserving null dates", () => {
    const source = {
      ...scalarRow("Market"),
      createdAt: new Date("2026-06-19T12:00:00Z"),
      updatedAt: instant,
      closesAt: new Date("2026-09-21T12:00:00Z"),
      resolvesAt: new Date("2026-09-22T12:00:00Z"),
      resolvedAt: null,
    };
    const encoded = encodeFixtureRow("Market", source);
    const shift = 45 * 86_400_000;
    const decoded = decodeFixtureRow("Market", encoded, shift);
    for (const key of ["createdAt", "updatedAt", "closesAt", "resolvesAt"] as const) {
      expect(decoded[key]).toEqual(new Date(source[key].getTime() + shift));
    }
    expect(decoded.resolvedAt).toBeNull();
    expect(encoded.closesAt).toBe(source.closesAt.toISOString());
  });

  it.each(["1.25", "1e6", "not-an-integer", "", 9_007_199_254_740_992])("rejects invalid bigint representation %j", value => {
    const row = encodeFixtureRow("LedgerPosting", scalarRow("LedgerPosting"));
    expect(() => decodeFixtureRow("LedgerPosting", { ...row, amountMilli: value })).toThrow();
  });

  it("rejects invalid dates when exporting and importing", () => {
    expect(() => encodeFixtureRow("LedgerPosting", { ...scalarRow("LedgerPosting"), createdAt: new Date("invalid") })).toThrow();
    const row = encodeFixtureRow("LedgerPosting", scalarRow("LedgerPosting"));
    for (const value of ["not-a-date", "", 1234]) {
      expect(() => decodeFixtureRow("LedgerPosting", { ...row, createdAt: value })).toThrow();
    }
  });
});
