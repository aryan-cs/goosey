import { setTimeout as delay } from "node:timers/promises";
import { ingestFinalizedProgramPage } from "../src/lib/solana/ingestion-worker";
import { resolveSolanaRuntime } from "../src/lib/solana/runtime";

const help = `Usage: npm run chain:index -- --coverage-start=SIGNATURE [--continuous] [--page-size=25] [--interval-ms=5000]

Index finalized Goosey transactions into the configured database journal.
Requires explicit GOOSEY_SOLANA_* and database environment configuration and
the additive journal/cursor migrations already applied. Does not migrate,
mint, transfer, trade, or submit any chain transaction. The coverage signature
is an inclusive immutable history boundary, not an inferred genesis claim.
Default: one bounded page, then exit. Continuous mode resumes saved progress
and stops on any verification/history error without advancing past it.
`;
const stopping = new AbortController();
for (const name of ["SIGINT", "SIGTERM"] as const) process.once(name, () => stopping.abort());

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(help); return; }
  const values = new Map<string, string>();
  for (const arg of args) {
    const [key, ...rest] = arg.split("=");
    if (!(["--coverage-start", "--page-size", "--interval-ms", "--continuous"].includes(key))
      || values.has(key) || (key === "--continuous" ? rest.length !== 0 : rest.length !== 1 || !rest[0])) {
      throw new Error("Invalid or duplicate indexer argument; use --help");
    }
    values.set(key, rest[0] ?? "true");
  }
  const coverage = values.get("--coverage-start");
  if (!coverage) throw new Error("Explicit --coverage-start signature required");
  function integer(key: string, fallback: number, min: number, max: number) {
    const value = values.get(key);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error("Invalid indexer integer option");
    return n;
  }
  const pageSize = integer("--page-size", 25, 1, 100), interval = integer("--interval-ms", 5000, 1000, 60_000);
  const runtime = resolveSolanaRuntime();
  let lastStatus: string | undefined;
  try {
    do {
      if (stopping.signal.aborted) return;
      const result = await ingestFinalizedProgramPage(runtime, coverage, {
        pageSize, signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(60_000)]),
      });
      if (result.status !== "idle" || lastStatus !== "idle") console.log(JSON.stringify({ event: "solana_index_page",
        status: result.status, verifiedReceipts: result.verifiedReceipts, insertedReceipts: result.insertedReceipts,
        revision: result.cursor.revision, finalizedRoot: result.finalizedRoot.toString(),
        backfillComplete: result.cursor.backfillComplete }));
      lastStatus = result.status;
      if (!values.has("--continuous")) return;
      await delay(interval, undefined, { signal: stopping.signal });
    } while (!stopping.signal.aborted);
  } finally {
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
  }
}
void main().catch(error => {
  if (stopping.signal.aborted) return;
  // Provider messages may contain private RPC URLs or credentials. Keep them
  // out of process logs; typed failures remain available to library callers.
  console.error(JSON.stringify({ event: "solana_indexer_stopped", errorType: error instanceof Error ? error.name : "UnknownError",
    message: "Indexing stopped without skipping unverified history. Check configuration, migrations and coverage availability." }));
  process.exitCode = 1;
});
