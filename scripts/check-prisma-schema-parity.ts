import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

type LogicalBlock = {
  kind: "model" | "enum" | "type" | "view";
  name: string;
  statements: string[];
};

export type SchemaParityResult = {
  ok: boolean;
  differences: string[];
};

const BLOCK_START = /^\s*(model|enum|type|view)\s+([A-Za-z][A-Za-z0-9_]*)\s*\{\s*$/;
const ALLOWED_POSTGRES_NATIVE_TYPE = "@db.Timestamptz(3)";

function stripLineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && character === "/" && line[index + 1] === "/") {
      return line.slice(0, index);
    }
  }

  return line;
}

function normalizeWhitespace(value: string): string {
  let normalized = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let pendingSpace = false;

  for (const character of value.trim()) {
    if (escaped) {
      normalized += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      normalized += character;
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      if (pendingSpace && normalized) normalized += " ";
      pendingSpace = false;
      normalized += character;
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && /\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && normalized) normalized += " ";
    pendingSpace = false;
    normalized += character;
  }

  return normalized;
}

function nestingDelta(value: string): number {
  let delta = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (!quote && (character === "(" || character === "[")) delta += 1;
    if (!quote && (character === ")" || character === "]")) delta -= 1;
  }

  return delta;
}

function splitStatements(lines: string[]): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;

  for (const rawLine of lines) {
    const line = stripLineComment(rawLine).trim();
    if (!line || line.startsWith("///")) continue;
    current = current ? `${current} ${line}` : line;
    depth += nestingDelta(line);
    if (depth === 0) {
      statements.push(current);
      current = "";
    }
  }

  if (current || depth !== 0) {
    throw new Error("Unbalanced or incomplete Prisma block statement");
  }
  return statements;
}

function extractBlocks(source: string): LogicalBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: LogicalBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(BLOCK_START);
    if (!match) continue;

    const body: string[] = [];
    let foundEnd = false;
    for (index += 1; index < lines.length; index += 1) {
      if (lines[index].trim() === "}") {
        foundEnd = true;
        break;
      }
      body.push(lines[index]);
    }
    if (!foundEnd) throw new Error(`Unclosed ${match[1]} ${match[2]}`);

    blocks.push({
      kind: match[1] as LogicalBlock["kind"],
      name: match[2],
      statements: splitStatements(body),
    });
  }

  return blocks;
}

function readProvider(source: string): string | null {
  const datasource = source.match(/datasource\s+db\s*\{([\s\S]*?)\}/)?.[1];
  return datasource?.match(/\bprovider\s*=\s*"([^"]+)"/)?.[1] ?? null;
}

function canonicalStatement(statement: string, dialect: "sqlite" | "postgresql"): string {
  const nativeTypes: string[] = statement.match(/@db\.[A-Za-z0-9_]+(?:\([^)]*\))?/g) ?? [];
  const fieldType = statement.match(/^\w+\s+([^\s]+)/)?.[1];
  if (dialect === "sqlite" && nativeTypes.length > 0) {
    throw new Error(`SQLite logical schema contains a native type: ${statement}`);
  }
  if (
    dialect === "postgresql" &&
    (fieldType === "DateTime" || fieldType === "DateTime?") &&
    !nativeTypes.includes(ALLOWED_POSTGRES_NATIVE_TYPE)
  ) {
    throw new Error(
      `PostgreSQL DateTime field must declare ${ALLOWED_POSTGRES_NATIVE_TYPE}: ${statement}`,
    );
  }
  for (const nativeType of nativeTypes) {
    if (nativeType !== ALLOWED_POSTGRES_NATIVE_TYPE) {
      throw new Error(`PostgreSQL native type is not allowlisted: ${nativeType}`);
    }
    if (fieldType !== "DateTime" && fieldType !== "DateTime?") {
      throw new Error(`${ALLOWED_POSTGRES_NATIVE_TYPE} is only allowed on DateTime fields`);
    }
  }

  return normalizeWhitespace(statement.replaceAll(ALLOWED_POSTGRES_NATIVE_TYPE, ""));
}

function canonicalBlocks(source: string, dialect: "sqlite" | "postgresql"): Map<string, string[]> {
  const canonical = new Map<string, string[]>();
  for (const block of extractBlocks(source)) {
    const key = `${block.kind} ${block.name}`;
    if (canonical.has(key)) throw new Error(`Duplicate logical block: ${key}`);
    canonical.set(
      key,
      block.statements.map((statement) => canonicalStatement(statement, dialect)).sort(),
    );
  }
  return canonical;
}

export function comparePrismaSchemas(sqliteSource: string, postgresSource: string): SchemaParityResult {
  const differences: string[] = [];
  const sqliteProvider = readProvider(sqliteSource);
  const postgresProvider = readProvider(postgresSource);
  if (sqliteProvider !== "sqlite") {
    differences.push(`SQLite schema datasource provider must be \"sqlite\", found ${JSON.stringify(sqliteProvider)}`);
  }
  if (postgresProvider !== "postgresql") {
    differences.push(
      `PostgreSQL schema datasource provider must be \"postgresql\", found ${JSON.stringify(postgresProvider)}`,
    );
  }

  let sqliteBlocks: Map<string, string[]>;
  let postgresBlocks: Map<string, string[]>;
  try {
    sqliteBlocks = canonicalBlocks(sqliteSource, "sqlite");
    postgresBlocks = canonicalBlocks(postgresSource, "postgresql");
  } catch (error) {
    differences.push(error instanceof Error ? error.message : String(error));
    return { ok: false, differences };
  }

  const blockNames = new Set([...sqliteBlocks.keys(), ...postgresBlocks.keys()]);
  for (const blockName of [...blockNames].sort()) {
    const sqliteStatements = sqliteBlocks.get(blockName);
    const postgresStatements = postgresBlocks.get(blockName);
    if (!sqliteStatements) {
      differences.push(`${blockName} exists only in the PostgreSQL schema`);
      continue;
    }
    if (!postgresStatements) {
      differences.push(`${blockName} exists only in the SQLite schema`);
      continue;
    }

    const sqliteOnly = sqliteStatements.filter((statement) => !postgresStatements.includes(statement));
    const postgresOnly = postgresStatements.filter((statement) => !sqliteStatements.includes(statement));
    if (sqliteOnly.length || postgresOnly.length) {
      differences.push(
        `${blockName} differs:\n` +
          sqliteOnly.map((statement) => `  SQLite only: ${statement}`).join("\n") +
          (sqliteOnly.length && postgresOnly.length ? "\n" : "") +
          postgresOnly.map((statement) => `  PostgreSQL only: ${statement}`).join("\n"),
      );
    }
  }

  return { ok: differences.length === 0, differences };
}

async function main(): Promise<void> {
  const sqlitePath = process.argv[2] ?? "prisma/schema.prisma";
  const postgresPath = process.argv[3] ?? "prisma/postgresql/schema.prisma";
  const [sqliteSource, postgresSource] = await Promise.all([
    readFile(sqlitePath, "utf8"),
    readFile(postgresPath, "utf8"),
  ]);
  const result = comparePrismaSchemas(sqliteSource, postgresSource);
  if (!result.ok) {
    throw new Error(`Prisma schema parity failed:\n${result.differences.join("\n")}`);
  }
  process.stdout.write(`Prisma schema parity passed (${sqlitePath} ↔ ${postgresPath}).\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
