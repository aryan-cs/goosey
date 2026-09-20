#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

const EXECUTE_CONFIRMATION = "ACCEPT_SOLANA_EDITORIAL_MIGRATION";
const PRODUCTION_CONFIRMATION = "MIGRATE_PRODUCTION_DATABASE_MARKET_EDITORIAL_DEFINITIONS";

const usage = `Usage:
  GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT=staging \\
  npx tsx scripts/migrate-database-editorials-to-solana.ts \\
    --environment=local|development|staging|production \\
    (--market-id=ID | --slug=SLUG | --all-database-drafts)

Dry-run is the default. Execute requires all of:
  --execute=${EXECUTE_CONFIRMATION}
  --actor-user-id=ADMIN_ID
  --confirm-genesis=HASH
  --confirm-program=ADDRESS

Production additionally requires:
  --allow-production=${PRODUCTION_CONFIRMATION}

The command only accepts durable hidden SOLANA provisioning intents. It does
not dispatch transactions, copy balances/positions/orders/fills, or create
financial ledger state. Markets with any financial activity are blocked.
`;

export type EditorialMigrationCliOptions = Readonly<{
  mode: "dry-run" | "execute";
  environment: "local" | "development" | "staging" | "production";
  selector: Readonly<{ marketIds?: readonly string[]; slugs?: readonly string[]; allDatabaseDrafts?: boolean }>;
  actorUserId?: string;
  confirmGenesis?: string;
  confirmProgram?: string;
}>;

export function parseEditorialMigrationArguments(args: readonly string[]): EditorialMigrationCliOptions | { mode: "help" } {
  const parsed = parseArgs({ args: [...args], strict: true, allowPositionals: false, options: {
    help: { type: "boolean", short: "h" },
    environment: { type: "string" },
    "market-id": { type: "string", multiple: true },
    slug: { type: "string", multiple: true },
    "all-database-drafts": { type: "boolean" },
    execute: { type: "string" },
    "actor-user-id": { type: "string" },
    "confirm-genesis": { type: "string" },
    "confirm-program": { type: "string" },
    "allow-production": { type: "string" },
  } });
  if (parsed.values.help) return { mode: "help" };
  const environment = parsed.values.environment;
  if (!environment || !["local", "development", "staging", "production"].includes(environment)) {
    throw new Error("--environment must explicitly name local, development, staging, or production");
  }
  const marketIds = parsed.values["market-id"] ?? [];
  const slugs = parsed.values.slug ?? [];
  const allDatabaseDrafts = parsed.values["all-database-drafts"] === true;
  if ((allDatabaseDrafts ? 1 : 0) + (marketIds.length || slugs.length ? 1 : 0) !== 1) {
    throw new Error("Select explicit markets or --all-database-drafts, but not both");
  }
  const execute = parsed.values.execute;
  if (execute !== undefined && execute !== EXECUTE_CONFIRMATION) throw new Error("Invalid --execute confirmation");
  const mode = execute === EXECUTE_CONFIRMATION ? "execute" : "dry-run";
  if (mode === "dry-run" && (parsed.values["actor-user-id"] || parsed.values["confirm-genesis"]
    || parsed.values["confirm-program"] || parsed.values["allow-production"])) {
    throw new Error("Write confirmations are not accepted during dry-run");
  }
  if (mode === "execute" && (!parsed.values["actor-user-id"] || !parsed.values["confirm-genesis"]
    || !parsed.values["confirm-program"])) throw new Error("Execute requires actor, genesis, and program confirmations");
  if (environment === "production" && mode === "execute"
    && parsed.values["allow-production"] !== PRODUCTION_CONFIRMATION) {
    throw new Error("Production execute requires the exact --allow-production confirmation");
  }
  if (environment !== "production" && parsed.values["allow-production"] !== undefined) {
    throw new Error("--allow-production is valid only with --environment=production");
  }
  return {
    mode,
    environment: environment as EditorialMigrationCliOptions["environment"],
    selector: { ...(marketIds.length ? { marketIds } : {}), ...(slugs.length ? { slugs } : {}),
      ...(allDatabaseDrafts ? { allDatabaseDrafts: true } : {}) },
    ...(parsed.values["actor-user-id"] ? { actorUserId: parsed.values["actor-user-id"] } : {}),
    ...(parsed.values["confirm-genesis"] ? { confirmGenesis: parsed.values["confirm-genesis"] } : {}),
    ...(parsed.values["confirm-program"] ? { confirmProgram: parsed.values["confirm-program"] } : {}),
  };
}

function assertEnvironment(options: EditorialMigrationCliOptions, env: Record<string, string | undefined>): void {
  if (env.GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT !== options.environment) {
    throw new Error("--environment must match GOOSEY_SOLANA_EDITORIAL_MIGRATION_ENVIRONMENT");
  }
  const processIsProduction = env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
  if (processIsProduction && options.environment !== "production") {
    throw new Error("The process identifies as production but --environment does not");
  }
  const runtime = resolveSolanaRuntime(env);
  if (options.mode === "execute" && (options.confirmGenesis !== runtime.genesisHash
    || options.confirmProgram !== runtime.programAddress)) {
    throw new Error("The execute confirmations do not match the resolved Solana deployment");
  }
}

export async function runEditorialMigrationCli(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
  writeOut: (text: string) => void = text => process.stdout.write(text),
  writeErr: (text: string) => void = text => process.stderr.write(text),
): Promise<number> {
  try {
    const options = parseEditorialMigrationArguments(args);
    if (options.mode === "help") { writeOut(usage); return 0; }
    assertEnvironment(options, env);
    // Database-backed code is loaded only after strict target and deployment validation.
    const service = await import("../src/lib/solana/database-editorial-migration-service");
    const common = { env, targetEnvironment: options.environment } as const;
    const inspected = await service.inspectDatabaseEditorialMigrations(options.selector, common);
    if (options.mode === "dry-run") {
      writeOut(`${JSON.stringify({ mode: options.mode, environment: options.environment, markets: inspected }, null, 2)}\n`);
      return inspected.some(item => item.state === "blocked") ? 2 : 0;
    }
    const results = [];
    for (const item of inspected) {
      if (item.state === "blocked") { results.push(item); continue; }
      try {
        results.push(await service.acceptDatabaseEditorialMigration(item.marketId, options.actorUserId!, {
          ...common,
          executeConfirmation: EXECUTE_CONFIRMATION,
          ...(options.environment === "production" ? { productionConfirmation: PRODUCTION_CONFIRMATION } : {}),
        }));
      } catch (error) {
        if (error instanceof service.EditorialMigrationBlockedError) results.push(error.assessment);
        else throw error;
      }
    }
    writeOut(`${JSON.stringify({ mode: options.mode, environment: options.environment, markets: results }, null, 2)}\n`);
    return results.some(item => item.state === "blocked") ? 2 : 0;
  } catch {
    writeErr("Editorial migration stopped safely. No Solana transaction was dispatched. Check explicit target, deployment confirmations, administrator identity, and the dry-run report.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runEditorialMigrationCli(process.argv.slice(2));
}
