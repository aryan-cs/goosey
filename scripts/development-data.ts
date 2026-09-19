import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SANDBOX_KIND, acquireSandboxLock, assertDevelopmentOnly, ensureSandboxPaths, readSandboxManifest, sandboxEnvironment } from "./lib/development-sandbox";
import { buildDevelopmentScenarios } from "./lib/development-scenarios";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: npm run data:dev -- <create|reset|verify|contribute|serve> [options]
  --name team             Isolated dataset under output/development-sandbox/
  --seed 20260919          Repeatable scenario seed (create/reset)
  --as-of <ISO timestamp>  End of the 90-day simulation (defaults to now)
  --count 20              Additional real sandbox trades (contribute)
  --port 8082             Local development server (serve)

create refuses to overwrite an existing dataset. reset archives the old dataset
before rebuilding. serve starts the app and settlement worker together; stop it
before reset/contribute. Agents can trade/comment normally through the running
app. Credentials are written to a private, ignored credentials.json file.
No command accepts a remote database URL or operates on prisma/dev.db.`;

function runNode(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: projectRoot, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Command failed (${signal ?? code}): ${args[0]}`)));
  });
}

async function serve(env: NodeJS.ProcessEnv, port: number) {
  const children = [
    spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0", "--port", String(port)], { cwd: projectRoot, env, stdio: "inherit" }),
    spawn(process.execPath, ["--import", "tsx", "scripts/settlement-worker.ts", "--continuous"], { cwd: projectRoot, env, stdio: "inherit" }),
  ];
  let stopping = false;
  const stop = () => { stopping = true; for (const child of children) child.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const exits = await Promise.allSettled(children.map((child) => new Promise<void>((resolve, reject) => {
      child.once("error", (error) => { stop(); reject(error); });
      child.once("exit", (code) => {
        const expected = stopping || code === 0;
        stop();
        if (expected) resolve(); else reject(new Error(`Sandbox service exited with code ${code}.`));
      });
    })));
    const failure = exits.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options: {
    name: { type: "string", default: "team" }, seed: { type: "string", default: "20260919" },
    "as-of": { type: "string" }, count: { type: "string", default: "20" },
    port: { type: "string", default: "8082" }, help: { type: "boolean" },
  }, allowPositionals: true, strict: true });
  if (values.help) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["create", "reset", "verify", "contribute", "serve"].includes(command)) throw new Error(help);
  assertDevelopmentOnly();
  const asOf = values["as-of"] ? new Date(values["as-of"]) : new Date();
  if (!Number.isFinite(asOf.getTime()) || asOf > new Date()) throw new Error("--as-of must be a valid timestamp at or before now.");
  const seed = Number(values.seed), count = Number(values.count), port = Number(values.port);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("--seed must be an unsigned 32-bit integer.");
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) throw new Error("--count must be 1–1000.");
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be 1024–65535.");
  const paths = await ensureSandboxPaths(projectRoot, values.name);
  const unlock = await acquireSandboxLock(paths.lock);
  let disconnect: (() => Promise<void>) | undefined;
  try {
    const exists = await access(paths.directory).then(() => true, () => false);
    if (command === "create" && exists) throw new Error("Dataset already exists. Use serve, or reset to archive and rebuild it.");
    if (command === "reset" && exists) {
      await readSandboxManifest(paths.manifest);
      const archive = path.join(paths.root, `${values.name}-archive-${Date.now()}-${randomUUID().slice(0, 8)}`);
      await rename(paths.directory, archive);
      console.log(`Previous sandbox archived at ${archive}`);
    }
    if (command === "create" || command === "reset") {
      await mkdir(paths.directory, { mode: 0o700 });
      // Prisma's SQLite schema engine expects an existing file on some platforms.
      await writeFile(paths.database, "", { flag: "wx", mode: 0o600 });
      const secret = randomBytes(32).toString("hex");
      const password = randomBytes(18).toString("base64url");
      await writeFile(paths.credentials, JSON.stringify({ password, secret }, null, 2), { mode: 0o600 });
      await writeFile(paths.manifest, JSON.stringify({ kind: SANDBOX_KIND, state: "building", seed, asOf: asOf.toISOString(), synthetic: true }, null, 2), { mode: 0o600 });
      const env = sandboxEnvironment(paths.database, secret, port);
      Object.assign(process.env, env);
      await runNode(["node_modules/prisma/build/index.js", "db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"], env);
      const engine = await import("./lib/development-replay");
      disconnect = engine.disconnectDevelopmentDatabase;
      const scenarios = buildDevelopmentScenarios({ asOf, seed });
      const result = await engine.replayDevelopmentData({ scenarios, password, asOf, onProgress: console.log });
      const { db } = await import("../src/lib/db");
      const { validateDevelopmentData } = await import("./lib/development-data-validation");
      const validation = await validateDevelopmentData(db, { asOf });
      console.log(JSON.stringify(validation, null, 2));
      if (validation.errors.length) throw new Error("Generated data failed independent validation; sandbox has not been marked ready.");
      await writeFile(paths.credentials, JSON.stringify({ password, secret, accounts: result.accounts }, null, 2), { mode: 0o600 });
      await disconnect();
      disconnect = undefined;
      await runNode(["--import", "tsx", "scripts/reconcile.ts"], env);
      await writeFile(paths.manifest, JSON.stringify({ kind: SANDBOX_KIND, state: "ready", seed, asOf: asOf.toISOString(), synthetic: true, result }, null, 2), { mode: 0o600 });
      console.log(`Synthetic sandbox ready: ${paths.directory}\nLogin credentials: ${paths.credentials}\nRun: npm run data:dev -- serve --name ${values.name} --port ${port}`);
      return;
    }
    const manifest = await readSandboxManifest(paths.manifest);
    if (manifest.state !== "ready") throw new Error("Dataset generation did not finish. Use reset to rebuild it.");
    const credentials = JSON.parse(await readFile(paths.credentials, "utf8")) as { secret: string };
    const env = sandboxEnvironment(paths.database, credentials.secret, port);
    Object.assign(process.env, env);
    if (command === "serve") {
      console.log(`SYNTHETIC DEVELOPMENT DATA — http://localhost:${port}\nAll writes stay in ${paths.database}`);
      await serve(env, port);
      return;
    }
    if (command === "contribute") {
      const engine = await import("./lib/development-replay");
      disconnect = engine.disconnectDevelopmentDatabase;
      console.log(JSON.stringify(await engine.appendDevelopmentTrades({ count }), null, 2));
    }
    const { db } = await import("../src/lib/db");
    disconnect ??= () => db.$disconnect();
    const { validateDevelopmentData } = await import("./lib/development-data-validation");
    const report = await validateDevelopmentData(db, { asOf: new Date() });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) throw new Error("Synthetic dataset validation failed.");
    await disconnect();
    disconnect = undefined;
    await runNode(["--import", "tsx", "scripts/reconcile.ts"], env);
  } finally {
    await disconnect?.();
    await unlock();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
