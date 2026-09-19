#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { inspectSolanaReleaseReadiness } from "../src/lib/solana/release-readiness";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

const usage = `Usage: npm run chain:release-readiness

Reads only the configured localnet/devnet deployment, published market catalog,
retained terms store, and indexer status. It never signs or submits transactions.
Configuration comes from GOOSEY_SOLANA_* and DATABASE_* environment variables.`;

export async function runSolanaReleaseReadinessCommand(options: {
  argv?: string[];
  env?: Record<string, string | undefined>;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
} = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const writeOut = options.writeOut ?? (text => process.stdout.write(text));
  const writeErr = options.writeErr ?? (text => process.stderr.write(text));
  try {
    const parsed = parseArgs({ args: argv, options: { help: { type: "boolean", short: "h" } },
      strict: true, allowPositionals: false });
    if (parsed.values.help) { writeOut(`${usage}\n`); return 0; }
    const runtime = resolveSolanaRuntime(env);
    // Delay database-backed adapters until after syntax/help/runtime validation.
    const { defaultReleaseReadinessDependencies } = await import("../src/lib/solana/release-readiness-boundaries");
    const report = await inspectSolanaReleaseReadiness({ runtime,
      termsDirectory: env.GOOSEY_SOLANA_TERMS_DIRECTORY,
      catalogEnabled: env.GOOSEY_SOLANA_CATALOG_ENABLED === "true" }, defaultReleaseReadinessDependencies);
    writeOut(`${JSON.stringify(report)}\n`);
    return report.ready ? 0 : 1;
  } catch {
    // Never relay provider/database/filesystem errors: they may contain RPC
    // query credentials, database passwords, or private local paths.
    writeErr("Solana release readiness unavailable. Verify the pinned non-mainnet deployment, database, retained terms, and indexer configuration. No transaction was signed or submitted.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSolanaReleaseReadinessCommand();
}
