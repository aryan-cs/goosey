import { parseArgs } from "node:util";
import { createSqliteBackup } from "./lib/sqlite-backup";

const usage = "Usage: npm run db:backup:sqlite -- --source /absolute/source.db --output /absolute/new-backup.db";

try {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(`${usage}\nCreates a verified, private SQLite snapshot without overwriting an existing file. Requires sqlite3.\n`);
  } else {
    if (!values.source || !values.output) throw new Error(usage);
    const backup = await createSqliteBackup(values.source, values.output);
    process.stdout.write(`${JSON.stringify({ status: "verified", ...backup })}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "SQLite backup failed.");
  process.exitCode = 1;
}
