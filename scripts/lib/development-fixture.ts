import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { isDevelopmentIdentity } from "./development-profiles";

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export const FIXTURE_FORMAT = "goosey-public-synthetic-v1";
// Deliberately exclude authentication, invitations, request caches, worker state
// and arbitrary audit metadata. This format currently supports LMSR data only.
export const PUBLIC_FIXTURE_MODELS = [
  "User", "LedgerAccount", "MarketEvent", "Market", "Position", "Trade",
  "JournalEntry", "LedgerPosting", "MarketResolutionProposal", "MarketSettlementRun",
  "PositionSettlement", "MarketPriceSnapshot", "Comment", "CommentReport",
  "WatchlistEntry", "MarketSuggestion", "Notification",
] as const;

export type FixtureModel = typeof PUBLIC_FIXTURE_MODELS[number];
export type FixtureManifest = {
  format: typeof FIXTURE_FORMAT;
  synthetic: true;
  capturedAt: string;
  sourceAsOf: string;
  seed: number;
  schemaSha256: string;
  tables: Array<{ model: FixtureModel; file: string; rows: number; sha256: string }>;
};

export function sha256(content: string | Buffer) { return createHash("sha256").update(content).digest("hex"); }

export function fixtureFields(model: string) {
  if (!(PUBLIC_FIXTURE_MODELS as readonly string[]).includes(model)) throw new Error(`Model is not public fixture data: ${model}`);
  const schema = Prisma.dmmf.datamodel.models.find(candidate => candidate.name === model)!;
  return schema.fields.filter(field => field.kind === "scalar" && !(model === "User" && field.name === "passwordHash"));
}

/** Called before DB reads so password hashes are never selected into the export. */
export function fixtureSelect(model: string) {
  return Object.fromEntries(fixtureFields(model).map(field => [field.name, true]));
}

export function encodeFixtureRow(model: string, row: Record<string, unknown>): Record<string, JSONValue> {
  const output: Record<string, JSONValue> = {};
  for (const field of fixtureFields(model)) {
    const value = row[field.name];
    if (model === "JournalEntry" && field.name === "metadata") output[field.name] = "{}";
    else if (model === "MarketSettlementRun" && ["claimToken", "leaseExpiresAt", "lastError"].includes(field.name)) output[field.name] = null;
    else if (value instanceof Date) output[field.name] = value.toISOString();
    else if (typeof value === "bigint") output[field.name] = value.toString();
    else if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") output[field.name] = value;
    else throw new Error(`Missing or unsupported scalar ${model}.${field.name}`);
  }
  return output;
}

/** Validate types and field names before passing any fixture row into Prisma. */
export function decodeFixtureRow(model: string, row: Record<string, unknown>, shiftMs = 0): Record<string, unknown> {
  if (!row || typeof row !== "object" || Array.isArray(row) || !Number.isSafeInteger(shiftMs)) throw new Error("Invalid fixture row or time shift.");
  const fields = fixtureFields(model);
  const known = new Set(fields.map(field => field.name));
  for (const key of Object.keys(row)) if (!known.has(key)) throw new Error(`Unexpected fixture field: ${model}.${key}`);
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const value = row[field.name];
    const fail = () => { throw new Error(`Invalid fixture value: ${model}.${field.name}`); };
    if (value === null && !field.isRequired) { output[field.name] = null; continue; }
    if (value === undefined || value === null) fail();
    switch (field.type) {
      case "BigInt":
        if (typeof value !== "string" || !/^-?(0|[1-9]\d*)$/.test(value)) fail();
        output[field.name] = BigInt(value as string);
        break;
      case "DateTime": {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail();
        const original = new Date(value as string);
        if (!Number.isFinite(original.getTime()) || original.toISOString() !== value) fail();
        const date = new Date(original.getTime() + shiftMs);
        if (!Number.isFinite(date.getTime())) fail();
        output[field.name] = date;
        break;
      }
      case "Int": if (!Number.isSafeInteger(value)) fail(); output[field.name] = value; break;
      case "Boolean": if (typeof value !== "boolean") fail(); output[field.name] = value; break;
      case "String": if (typeof value !== "string") fail(); output[field.name] = value; break;
      default: throw new Error(`Unsupported schema type: ${field.type}`);
    }
  }
  if (model === "JournalEntry" && output.metadata !== "{}") throw new Error("Public fixture journal metadata must be redacted.");
  if (model === "MarketSettlementRun" && (output.claimToken !== null || output.leaseExpiresAt !== null || output.lastError !== null || output.status !== "COMPLETED")) {
    throw new Error("Only completed, unclaimed settlement runs belong in the public fixture.");
  }
  return output;
}

export function assertSyntheticIdentities(users: Record<string, unknown>[], markets: Record<string, unknown>[]) {
  if (!users.length || !markets.length) throw new Error("Fixture requires synthetic users and markets.");
  for (const user of users) {
    if (!isDevelopmentIdentity(user)) {
      throw new Error("Only the known fictional fixture accounts with their expected roles and @example.test login emails may be published or imported.");
    }
  }
  for (const market of markets) {
    if (typeof market.slug !== "string" || !market.slug.startsWith("dev-") || market.pricingModel !== "LMSR") {
      throw new Error("Public fixture supports only dev-* LMSR markets; export order-book data separately with its complete accounting graph.");
    }
  }
}
