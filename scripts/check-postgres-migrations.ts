import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export type PostgresMigrationContract = {
  lockSource: string;
  generatedBaseline: string;
  migrationDirectories: string[];
  migrationSources: Record<string, string>;
};

const MIGRATION_NAME = /^(\d{14})_[a-z0-9][a-z0-9_-]*$/;
const BASELINE_NAME = "00000000000000_baseline";

export function validatePostgresMigrationContract(contract: PostgresMigrationContract): string[] {
  const errors: string[] = [];
  const provider = contract.lockSource.match(/^\s*provider\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (provider !== "postgresql") {
    errors.push(`migration_lock.toml must declare provider = "postgresql"; found ${JSON.stringify(provider ?? null)}`);
  }

  const timestamps = new Set<string>();
  for (const directory of contract.migrationDirectories) {
    const match = directory.match(MIGRATION_NAME);
    if (!match) {
      errors.push(`Invalid PostgreSQL migration directory name: ${directory}`);
      continue;
    }
    if (timestamps.has(match[1])) errors.push(`Duplicate PostgreSQL migration timestamp: ${match[1]}`);
    timestamps.add(match[1]);

    const source = contract.migrationSources[directory];
    if (typeof source !== "string" || !source.trim()) {
      errors.push(`Missing or empty migration.sql for ${directory}`);
      continue;
    }
    if (/\b(?:PRAGMA|AUTOINCREMENT|WITHOUT\s+ROWID)\b/i.test(source)) {
      errors.push(`SQLite-only SQL found in PostgreSQL migration ${directory}`);
    }
  }

  const baselineMigration = contract.migrationSources[BASELINE_NAME];
  if (!contract.migrationDirectories.includes(BASELINE_NAME) || typeof baselineMigration !== "string") {
    errors.push(`Missing required PostgreSQL baseline migration ${BASELINE_NAME}`);
  } else if (baselineMigration !== contract.generatedBaseline) {
    errors.push("The deployable PostgreSQL baseline migration differs from baseline.generated.sql");
  }

  if (/^\s*DROP\s+(?:TABLE|SCHEMA|DATABASE)\b/im.test(contract.generatedBaseline)) {
    errors.push("The initial PostgreSQL baseline contains a destructive DROP statement");
  }
  return errors;
}

async function loadContract(root = "prisma/postgresql"): Promise<PostgresMigrationContract> {
  const migrationsRoot = `${root}/migrations`;
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  const migrationDirectories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const migrationSources = Object.fromEntries(
    await Promise.all(
      migrationDirectories.map(async (directory) => [
        directory,
        await readFile(`${migrationsRoot}/${directory}/migration.sql`, "utf8"),
      ]),
    ),
  );
  return {
    lockSource: await readFile(`${migrationsRoot}/migration_lock.toml`, "utf8"),
    generatedBaseline: await readFile(`${root}/baseline.generated.sql`, "utf8"),
    migrationDirectories,
    migrationSources,
  };
}

async function main(): Promise<void> {
  const errors = validatePostgresMigrationContract(await loadContract(process.argv[2]));
  if (errors.length) throw new Error(`PostgreSQL migration contract failed:\n- ${errors.join("\n- ")}`);
  process.stdout.write("PostgreSQL migration contract passed.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
