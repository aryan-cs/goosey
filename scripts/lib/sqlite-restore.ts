import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_BYTES = 32 * 1024 * 1024;
const included = "(name NOT GLOB 'sqlite_*' OR name = 'sqlite_sequence')";
const schemaQuery = `SELECT json_array('schema', type, name, tbl_name, sql) AS record
  FROM sqlite_master WHERE ${included} ORDER BY type COLLATE BINARY, name COLLATE BINARY`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function query(path: string, sql: string): Promise<string> {
  try {
    const pending = execute("sqlite3", ["-readonly", "-batch", "-bail", "-init", "/dev/null", "-noheader", "-list", path], {
      timeout: 15_000,
      maxBuffer: MAX_BYTES,
      encoding: "utf8",
    });
    pending.child.stdin?.on("error", () => { /* Process failure is reported by execute. */ });
    pending.child.stdin?.end(`PRAGMA query_only=ON;\n${sql}\n`);
    return (await pending).stdout;
  } catch {
    // SQLite errors can echo SQL or data; never include child output in reports.
    throw new Error("Read-only SQLite comparison failed (invalid database or local comparison limit exceeded).");
  }
}

/** Bounded logical comparison for local, quiescent snapshot fixtures, not a backup certification service. */
export async function fingerprintSqlite(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("Database paths must be absolute filesystem paths.");
  if (!(await stat(path)).isFile()) throw new Error("Database must be an existing regular file.");
  const discovery = await query(path, `
    BEGIN;
    SELECT json_object(
      'schema', (SELECT json_group_array(record) FROM (${schemaQuery})),
      'tables', (SELECT json_group_array(json_object('name', name, 'columns',
        (SELECT json_group_array(name) FROM (SELECT name FROM pragma_table_xinfo(m.name) WHERE hidden != 1 ORDER BY cid))
      )) FROM (SELECT name FROM sqlite_master WHERE type='table' AND ${included} ORDER BY name COLLATE BINARY) AS m)
    );
    COMMIT;
  `);
  const metadata = JSON.parse(discovery) as { schema: string[]; tables: Array<{ name: string; columns: string[] }> };
  const statements = metadata.tables.map((table) => {
    // quote keeps integers out of JavaScript's lossy Number representation.
    // hex additionally preserves embedded NULs in TEXT, which quote truncates.
    const fields = table.columns.map((name) => {
      const column = identifier(name);
      return `json_array(typeof(${column}), quote(${column}), CASE WHEN typeof(${column})='text' THEN hex(CAST(${column} AS BLOB)) END)`;
    });
    return `SELECT json_array('row', ${literal(table.name)}, ${fields.join(", ")}) AS record FROM ${identifier(table.name)} ORDER BY record COLLATE BINARY;`;
  });
  const output = await query(path, `BEGIN;\n${schemaQuery};\n${statements.join("\n")}\nCOMMIT;`);
  const prefix = metadata.schema.length ? `${metadata.schema.join("\n")}\n` : "";
  // Refuse schema changes between discovery and the single read transaction.
  const lines = output.trimEnd().split("\n").filter(Boolean);
  const actualSchema = lines.filter((line) => JSON.parse(line)[0] === "schema");
  if (JSON.stringify(actualSchema) !== JSON.stringify(metadata.schema) || !output.startsWith(prefix)) {
    throw new Error("Database schema changed during comparison; use quiescent snapshots.");
  }
  return createHash("sha256").update(output).digest("hex");
}

export async function verifySqliteRestore(source: string, restored: string) {
  const sourceSha256 = await fingerprintSqlite(source);
  const restoredSha256 = await fingerprintSqlite(restored);
  if (sourceSha256 !== restoredSha256) throw new Error("SQLite restore mismatch: logical schema or table contents differ.");
  return { status: "matched" as const, sha256: sourceSha256 };
}
