import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, access, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PrismaClient, Prisma } from "@prisma/client";
import { hash } from "bcryptjs";
import { assertDevelopmentOnly, ensureSandboxPaths, readSandboxManifest, acquireSandboxLock, SANDBOX_KIND, sandboxEnvironment } from "./lib/development-sandbox";
import { FIXTURE_FORMAT, PUBLIC_FIXTURE_MODELS, assertSyntheticIdentities, encodeFixtureRow, decodeFixtureRow, fixtureSelect, sha256, type FixtureManifest, type FixtureModel } from "./lib/development-fixture";
import { validateDevelopmentData } from "./lib/development-data-validation";
import { hardenSqliteConnection } from "../src/lib/sqlite-startup";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(root, "fixtures", "synthetic", "three-months");
const schemaPath = path.join(root, "prisma", "schema.prisma");
type Row = Record<string, unknown>;
type Delegate = {
  findMany(args: { select: Record<string, boolean>; orderBy: { id: "asc" } }): Promise<Row[]>;
  createMany(args: { data: Row[] }): Promise<unknown>;
};
function delegate(client: PrismaClient | Prisma.TransactionClient, model: FixtureModel): Delegate {
  const property = model.charAt(0).toLowerCase() + model.slice(1);
  return (client as unknown as Record<string, Delegate>)[property];
}
function runNode(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Verification/setup command failed: ${args[0]} (${code})`)));
  });
}

async function exportFixture(name: string) {
  const paths = await ensureSandboxPaths(root, name);
  const source = await readSandboxManifest(paths.manifest);
  if (source.state !== "ready") throw new Error("Only a completed sandbox can be exported.");
  const datasourceUrl = `file:${paths.database}?connection_limit=1`;
  const client = new PrismaClient({ datasourceUrl });
  try {
    await hardenSqliteConnection(client, datasourceUrl);
    // A database snapshot, not a raw copy of the active WAL file. Browser and
    // worker activity may continue while this read-only transaction runs.
    const snapshot = await client.$transaction(async tx => {
      const rows = new Map<FixtureModel, Row[]>();
      for (const model of PUBLIC_FIXTURE_MODELS) {
        rows.set(model, await delegate(tx, model).findMany({ select: fixtureSelect(model), orderBy: { id: "asc" } }));
      }
      const capturedAt = new Date();
      assertSyntheticIdentities(rows.get("User")!, rows.get("Market")!);
      if (await tx.marketOrder.count() || await tx.orderFill.count() || await tx.orderReservation.count()) throw new Error("Order-book activity is outside this fixture format.");
      if (rows.get("MarketSettlementRun")!.some(run => run.status !== "COMPLETED")) throw new Error("Finish in-progress settlements before exporting.");
      if (rows.get("Market")!.some(market => market.status === "OPEN" && (market.closesAt as Date) <= capturedAt)) throw new Error("Open markets have expired; reset the development scenario before exporting a reusable baseline.");
      const validation = await validateDevelopmentData(tx, { asOf: capturedAt });
      if (validation.errors.length) throw new Error(`Source validation failed: ${validation.errors.join("; ")}`);
      return { rows, capturedAt, counts: validation.counts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 60_000 });

    for (const directory of [path.join(root, "fixtures"), path.join(root, "fixtures", "synthetic"), fixtureDirectory]) {
      await mkdir(directory, { recursive: true });
      const stat = await lstat(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unexpected fixture directory: ${directory}`);
    }
    const manifest: FixtureManifest = { format: FIXTURE_FORMAT, synthetic: true, capturedAt: snapshot.capturedAt.toISOString(), sourceAsOf: String(source.asOf), seed: Number(source.seed), schemaSha256: sha256(await readFile(schemaPath)), tables: [] };
    for (const model of PUBLIC_FIXTURE_MODELS) {
      const encoded = snapshot.rows.get(model)!.map(row => encodeFixtureRow(model, row));
      // Round-trip validation also checks that every required scalar was retained.
      for (const row of encoded) decodeFixtureRow(model, row);
      const content = encoded.map(row => JSON.stringify(row)).join("\n") + (encoded.length ? "\n" : "");
      const file = `${model}.jsonl`;
      const target = path.join(fixtureDirectory, file);
      const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`Unexpected export target: ${target}`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, target);
      manifest.tables.push({ model, file, rows: encoded.length, sha256: sha256(content) });
    }
    const manifestTarget = path.join(fixtureDirectory, "manifest.json");
    const manifestStat = await lstat(manifestTarget).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (manifestStat && (!manifestStat.isFile() || manifestStat.isSymbolicLink())) throw new Error("Unexpected fixture manifest target.");
    const manifestTemporary = `${manifestTarget}.${randomUUID()}.tmp`;
    await writeFile(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(manifestTemporary, manifestTarget);
    console.log(JSON.stringify({ folder: fixtureDirectory, capturedAt: manifest.capturedAt, counts: snapshot.counts }, null, 2));
  } finally { await client.$disconnect(); }
}

async function loadFixture() {
  const manifest = JSON.parse(await readFile(path.join(fixtureDirectory, "manifest.json"), "utf8")) as FixtureManifest;
  if (manifest.format !== FIXTURE_FORMAT || manifest.synthetic !== true || !Array.isArray(manifest.tables)) throw new Error("Not a supported synthetic fixture manifest.");
  if (manifest.schemaSha256 !== sha256(await readFile(schemaPath))) throw new Error("Fixture schema differs from this checkout; export an updated fixture with the matching schema.");
  const capturedAt = new Date(manifest.capturedAt);
  if (!Number.isFinite(capturedAt.getTime()) || capturedAt.toISOString() !== manifest.capturedAt) throw new Error("Invalid fixture capture time.");
  if (!Number.isSafeInteger(manifest.seed) || manifest.seed < 0) throw new Error("Invalid fixture seed.");
  if (manifest.tables.length !== PUBLIC_FIXTURE_MODELS.length) throw new Error("Fixture table list is incomplete.");
  const rows = new Map<FixtureModel, Row[]>();
  for (const table of manifest.tables) {
    if (!(PUBLIC_FIXTURE_MODELS as readonly string[]).includes(table.model) || rows.has(table.model) || table.file !== `${table.model}.jsonl` || !Number.isSafeInteger(table.rows) || table.rows < 0) throw new Error("Unexpected, repeated or invalid fixture table.");
    const content = await readFile(path.join(fixtureDirectory, table.file), "utf8");
    if (sha256(content) !== table.sha256) throw new Error(`Checksum mismatch: ${table.file}`);
    const values: Row[] = content.trim() ? content.trimEnd().split("\n").map(line => JSON.parse(line) as Row) : [];
    if (values.length !== table.rows) throw new Error(`Row count mismatch: ${table.file}`);
    for (const row of values) decodeFixtureRow(table.model, row);
    rows.set(table.model, values);
  }
  assertSyntheticIdentities(rows.get("User")!, rows.get("Market")!);
  return { manifest, rows, capturedAt };
}

async function importFixture(name: string, preserveDates: boolean) {
  // Validate the complete package before creating any destination files.
  const fixture = await loadFixture();
  const paths = await ensureSandboxPaths(root, name);
  const unlock = await acquireSandboxLock(paths.lock);
  let client: PrismaClient | undefined;
  try {
    if (await access(paths.directory).then(() => true, () => false)) throw new Error("Import never overwrites a dataset. Choose a new --name.");
    const importedAt = new Date();
    const shiftMs = preserveDates ? 0 : importedAt.getTime() - fixture.capturedAt.getTime();
    const password = randomBytes(18).toString("base64url"), secret = randomBytes(32).toString("hex");
    const passwordHash = await hash(password, 12), systemHash = await hash(randomBytes(32).toString("hex"), 12);
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.database, "", { flag: "wx", mode: 0o600 });
    const localManifest = { kind: SANDBOX_KIND, state: "building", seed: fixture.manifest.seed, asOf: (preserveDates ? fixture.capturedAt : importedAt).toISOString(), synthetic: true, source: "fixtures/synthetic/three-months", sourceCapturedAt: fixture.manifest.capturedAt, dateShiftMs: shiftMs };
    await writeFile(paths.manifest, JSON.stringify(localManifest, null, 2), { mode: 0o600 });
    const env = sandboxEnvironment(paths.database, secret);
    await runNode(["node_modules/prisma/build/index.js", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], env);
    client = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    await hardenSqliteConnection(client, env.DATABASE_URL!);
    const result = await client.$transaction(async tx => {
      // Defer FK enforcement until all related rows (including comment replies)
      // exist. Enforcement stays enabled, and commit still rejects broken links.
      await tx.$executeRawUnsafe("PRAGMA defer_foreign_keys = ON");
      for (const model of PUBLIC_FIXTURE_MODELS) {
        const data = fixture.rows.get(model)!.map(row => {
          const decoded = decodeFixtureRow(model, row, shiftMs);
          return model === "User" ? { ...decoded, passwordHash: decoded.role === "SYSTEM" ? systemHash : passwordHash } : decoded;
        });
        for (let start = 0; start < data.length; start += 100) await delegate(tx, model).createMany({ data: data.slice(start, start + 100) });
      }
      const foreignKeys = await tx.$queryRawUnsafe<unknown[]>("PRAGMA foreign_key_check");
      if (foreignKeys.length) throw new Error("Fixture contains broken database relationships.");
      const report = await validateDevelopmentData(tx, { asOf: new Date() });
      if (report.errors.length) throw new Error(`Imported fixture failed validation: ${report.errors.join("; ")}`);
      return report;
    }, { timeout: 120_000 });
    await client.$disconnect();
    client = undefined;
    await runNode(["--import", "tsx", "scripts/reconcile.ts"], env);
    const accounts = fixture.rows.get("User")!.filter(row => row.role !== "SYSTEM").map(({ id, email, username, role }) => ({ id, email, username, role }));
    await writeFile(paths.credentials, JSON.stringify({ password, secret, accounts }, null, 2), { mode: 0o600 });
    await writeFile(paths.manifest, JSON.stringify({ ...localManifest, state: "ready", result }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    console.log(`Imported synthetic data into ${paths.directory}\nFresh private login credentials: ${paths.credentials}\nRun: npm run data:dev -- serve --name ${name}`);
  } finally { await client?.$disconnect(); await unlock(); }
}

const help = `Usage: npm run data:fixture -- <export|import> [--name <sandbox>] [--preserve-dates]
export: read a consistent snapshot of the owned sandbox (default: team), remove
authentication material, and write fixtures/synthetic/three-months/*.jsonl.
import: restore that package into a NEW sandbox (default: shared), with fresh
local credentials. Dates shift together to now unless --preserve-dates is set.
Existing datasets and production databases are never overwritten.`;

async function main() {
  const { values, positionals } = parseArgs({ options: { name: { type: "string" }, "preserve-dates": { type: "boolean" }, help: { type: "boolean" } }, allowPositionals: true, strict: true });
  if (values.help) { console.log(help); return; }
  assertDevelopmentOnly();
  if (positionals.length !== 1) throw new Error(help);
  if (positionals[0] === "export") {
    if (values["preserve-dates"]) throw new Error("--preserve-dates is an import option.");
    await exportFixture(values.name ?? "team");
  } else if (positionals[0] === "import") await importFixture(values.name ?? "shared", values["preserve-dates"] ?? false);
  else throw new Error(help);
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
