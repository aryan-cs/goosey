import { mkdir, lstat, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

export const SANDBOX_KIND = "goosey-synthetic-development-v1";

export function sandboxPaths(projectRoot: string, name: string) {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error("Dataset names must contain 1–40 lowercase letters, digits or hyphens, starting with a letter.");
  const root = path.resolve(projectRoot, "output", "development-sandbox");
  const directory = path.join(root, name);
  return { root, directory, database: path.join(directory, "data.sqlite"), manifest: path.join(directory, "manifest.json"), credentials: path.join(directory, "credentials.json"), lock: path.join(root, `${name}.lock`) };
}

export function assertDevelopmentOnly(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" || env.VERCEL || env.RENDER || env.FLY_APP_NAME) {
    throw new Error("Synthetic data tooling is local-development only; refusing a production or hosted runtime.");
  }
}

/** Reject symlinks at every boundary, including an existing database or manifest. */
export async function ensureSandboxPaths(projectRoot: string, name: string) {
  const paths = sandboxPaths(projectRoot, name);
  for (const directory of [path.join(projectRoot, "output"), paths.root]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing non-directory or symlink: ${directory}`);
  }
  for (const target of [paths.directory, paths.database, paths.manifest, paths.credentials, paths.lock]) {
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error(`Refusing symlink: ${target}`);
    if (stat && (target === paths.directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unexpected filesystem entry: ${target}`);
    if (stat?.isFile() && stat.nlink !== 1) throw new Error(`Refusing multiply-linked file: ${target}`);
  }
  return paths;
}

export async function readSandboxManifest(filename: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
  if (manifest.kind !== SANDBOX_KIND) throw new Error("Missing sandbox ownership marker; refusing to modify this dataset.");
  return manifest;
}

export async function acquireSandboxLock(filename: string): Promise<() => Promise<void>> {
  const value = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    await writeFile(filename, value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await readFile(filename, "utf8")) as { pid?: number };
    if (!Number.isSafeInteger(prior.pid) || prior.pid! < 1) throw new Error("Invalid sandbox lock; inspect it manually before continuing.");
    try {
      process.kill(prior.pid!, 0);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
        await unlink(filename);
        return acquireSandboxLock(filename);
      }
      throw probeError;
    }
    throw new Error(`Sandbox is in use by process ${prior.pid}. Stop its server/worker before resetting or using the CLI; agents can contribute through the running app.`);
  }
  return async () => {
    if (await readFile(filename, "utf8").catch(() => "") === value) await unlink(filename);
  };
}

export function sandboxEnvironment(database: string, secret: string, port = 8082): NodeJS.ProcessEnv {
  const origin = `http://localhost:${port}`;
  return {
    ...process.env,
    NODE_ENV: "development",
    DATABASE_PROVIDER: "sqlite",
    DATABASE_URL: `file:${database}?connection_limit=1`,
    POSTGRES_DATABASE_URL: "",
    POSTGRES_DIRECT_DATABASE_URL: "",
    GOOSEY_DEVELOPMENT_SANDBOX: "1",
    STARTING_FEATHERS: "100000",
    SESSION_COOKIE_NAME: "goosey_sandbox_session",
    APP_URL: origin,
    NEXT_PUBLIC_APP_URL: origin,
    EMAIL_VERIFICATION_URL: `${origin}/verify-email`,
    PASSWORD_RESET_URL: `${origin}/reset-password`,
    RATE_LIMIT_KEY_SECRET: secret,
    GOOSEY_TOKEN_SECRET: secret,
    // Never send fixture email through a developer's real SMTP account.
    SMTP_HOST: "", SMTP_USER: "", SMTP_PASSWORD: "", SMTP_FROM: "",
  };
}
