/** Operator-only catalog registration. Import/help performs no database I/O. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseRuntime } from "../src/lib/database-runtime";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

export const registerMarketHelp = `Usage:
  node --import tsx scripts/solana-register-market.ts --actor-user-id ID --chain-market-id U64 --slug SLUG --short-title TEXT --description TEXT --category TEXT

Registers an existing verified chain market in the SQL catalog as DRAFT/SOLANA.
All six options are required, once each, as separate option/value pairs.
Requires explicit GOOSEY_SOLANA_CLUSTER/RPC_URL/PROGRAM_ID/GENESIS_HASH,
GOOSEY_SOLANA_TERMS_DIRECTORY (existing canonical absolute private directory),
and the existing server database environment. No dotenv files are loaded.
The actor must be an existing ACTIVE ADMIN. This is a trusted operator command,
not an authentication endpoint. It does not create/open a chain market, sign,
fund, grant feathers, create financial accounts, migrate, or publish a listing.
Identical registration is idempotent; different identity/metadata conflicts.
Exit 0: success/help; exit 1: stopped. On uncertainty, inspect and repeat only
the same request; do not change identity or metadata to bypass a conflict.`;

const names = ["--actor-user-id", "--chain-market-id", "--slug", "--short-title", "--description", "--category"];
export function parseRegisterMarketArguments(args: readonly string[]) {
  if (args.length !== names.length * 2) throw new Error("Invalid arguments");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!names.includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error("Invalid arguments");
    values.set(key, value);
  }
  const actorUserId = values.get("--actor-user-id")!;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(actorUserId)) throw new Error("Invalid actor ID");
  const id = values.get("--chain-market-id")!;
  if (!/^(0|[1-9][0-9]{0,19})$/.test(id) || BigInt(id) > (1n << 64n) - 1n) throw new Error("Invalid market ID");
  function text(key: string, min: number, max: number) {
    const value = values.get(key)!;
    if (value !== value.trim() || value.length < min || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
      throw new Error("Invalid metadata");
    }
    return value;
  }
  const slug = text("--slug", 3, 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Invalid slug");
  return { actorUserId, chainMarketId: BigInt(id), metadata: { slug,
    shortTitle: text("--short-title", 3, 90), description: text("--description", 20, 5000), category: text("--category", 2, 60) } };
}

// Deliberately allowlisted codes only; exception text/SQL/provider URLs are never echoed.
const safeServiceCodes = new Set(["ADMIN_REQUIRED", "CHAIN_MARKET_NOT_PUBLISHED", "CHAIN_CATALOG_CONFLICT"]);
export async function runRegisterMarketCli(args: readonly string[]): Promise<number> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(registerMarketHelp); return 0; }
  let stage = "ARGUMENTS";
  let disconnect: (() => Promise<void>) | undefined;
  let exitCode = 1;
  try {
    const options = parseRegisterMarketArguments(args);
    stage = "CONFIGURATION";
    const env = { ...process.env };
    for (const key of ["GOOSEY_SOLANA_CLUSTER", "GOOSEY_SOLANA_RPC_URL", "GOOSEY_SOLANA_PROGRAM_ID", "GOOSEY_SOLANA_GENESIS_HASH"]) {
      if (!env[key]) throw new Error("Explicit runtime required");
    }
    const runtime = resolveSolanaRuntime(env);
    resolveDatabaseRuntime(env);
    const termsDirectory = env.GOOSEY_SOLANA_TERMS_DIRECTORY;
    if (!termsDirectory || !path.isAbsolute(termsDirectory) || path.normalize(termsDirectory) !== termsDirectory
      || termsDirectory === path.parse(termsDirectory).root || /[\u0000-\u001f\u007f]/u.test(termsDirectory)) throw new Error("Invalid terms directory");
    stage = "DATABASE_STARTUP";
    const { db, requireDatabaseStartup } = await import("../src/lib/db");
    disconnect = () => db.$disconnect();
    await requireDatabaseStartup();
    stage = "REGISTRATION";
    const { registerSolanaMarket } = await import("../src/lib/solana/market-catalog");
    const result = await registerSolanaMarket({ ...options, runtime, termsDirectory });
    console.log(JSON.stringify({ event: "solana_market_registered", created: result.created,
      marketId: result.market.id, chainMarketId: result.binding.chainMarketId,
      status: result.market.status, executionBackend: result.market.executionBackend }));
    exitCode = 0;
  } catch (error) {
    const code = stage === "REGISTRATION" && error && typeof error === "object" && "code" in error
      && typeof error.code === "string" && safeServiceCodes.has(error.code) ? error.code : stage;
    console.error(JSON.stringify({ event: "solana_market_registration_stopped", code,
      message: "Check arguments, server configuration, startup guards and verified market eligibility. No automatic retry. Use --help." }));
  } finally {
    try { await disconnect?.(); } catch {
      console.error(JSON.stringify({ event: "solana_market_registration_stopped", code: "DATABASE_DISCONNECT",
        message: "Database cleanup failed. Registration may already be committed; inspect before retrying." }));
      exitCode = 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRegisterMarketCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
