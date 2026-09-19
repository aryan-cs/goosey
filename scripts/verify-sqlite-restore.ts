import { parseArgs } from "node:util";
import { verifySqliteRestore } from "./lib/sqlite-restore";

const usage = "Usage: node --import tsx scripts/verify-sqlite-restore.ts --source /absolute/archive.db --restored /absolute/copy.db";

try {
  const { values } = parseArgs({
    options: { source: { type: "string" }, restored: { type: "string" }, help: { type: "boolean" } },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(`${usage}\nRead-only logical comparison for quiescent local fixtures (32 MiB output / 15s per SQLite query). Ignores internal SQLite statistics; includes sqlite_sequence. Not production backup certification.`);
  } else {
    if (!values.source || !values.restored) throw new Error(usage);
    console.log(JSON.stringify(await verifySqliteRestore(values.source, values.restored)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "SQLite restore verification failed.");
  process.exitCode = 1;
}
