import { describe, expect, it } from "vitest";

import { parseEditorialMigrationArguments } from "./migrate-database-editorials-to-solana";

describe("database editorial migration CLI", () => {
  it("defaults to a read-only dry-run with an explicit environment and bounded selection", () => {
    expect(parseEditorialMigrationArguments(["--environment=staging", "--slug=editorial-market"]))
      .toEqual({ mode: "dry-run", environment: "staging", selector: { slugs: ["editorial-market"] } });
  });

  it("requires exact execute and deployment confirmations", () => {
    expect(() => parseEditorialMigrationArguments(["--environment=staging", "--market-id=market_1", "--execute=yes"]))
      .toThrow("Invalid --execute confirmation");
    expect(() => parseEditorialMigrationArguments(["--environment=staging", "--market-id=market_1",
      "--execute=ACCEPT_SOLANA_EDITORIAL_MIGRATION"])).toThrow("Execute requires actor, genesis, and program confirmations");
  });

  it("requires an additional exact production write acknowledgement", () => {
    const base = ["--environment=production", "--market-id=market_1", "--execute=ACCEPT_SOLANA_EDITORIAL_MIGRATION",
      "--actor-user-id=admin_1", "--confirm-genesis=genesis", "--confirm-program=program"];
    expect(() => parseEditorialMigrationArguments(base)).toThrow("Production execute requires");
    expect(parseEditorialMigrationArguments([...base,
      "--allow-production=MIGRATE_PRODUCTION_DATABASE_MARKET_EDITORIAL_DEFINITIONS"]))
      .toMatchObject({ mode: "execute", environment: "production", selector: { marketIds: ["market_1"] } });
  });

  it("rejects broad and explicit selectors together and rejects write flags in dry-run", () => {
    expect(() => parseEditorialMigrationArguments(["--environment=local", "--all-database-drafts", "--slug=one"]))
      .toThrow("Select explicit markets");
    expect(() => parseEditorialMigrationArguments(["--environment=local", "--slug=one", "--actor-user-id=admin_1"]))
      .toThrow("Write confirmations are not accepted");
  });
});
