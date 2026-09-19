import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  open,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SQLITE_TIMEOUT_MS = 120_000;
const SQLITE_MAX_BUFFER_BYTES = 64 * 1024;

function normalizeAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${label} must not contain a null byte.`);
  }
  return path.normalize(value);
}

async function lstatIfPresent(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runSqlite(args: readonly string[]): Promise<string> {
  try {
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-batch", "-bail", "-init", nullDevice, ...args],
      {
      encoding: "utf8",
      timeout: SQLITE_TIMEOUT_MS,
      maxBuffer: SQLITE_MAX_BUFFER_BYTES,
      windowsHide: true,
      },
    );
    return stdout;
  } catch (error) {
    throw new Error("The sqlite3 backup operation failed.", { cause: error });
  }
}

async function fsyncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.length;
    hash.update(chunk);
  }

  return { bytes, sha256: hash.digest("hex") };
}

export async function createSqliteBackup(
  source: string,
  destination: string,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const sourcePath = normalizeAbsolutePath(source, "Source");
  const destinationPath = normalizeAbsolutePath(destination, "Destination");

  if (sourcePath === destinationPath) {
    throw new Error("Source and destination must be different paths.");
  }

  const sourceStat = await lstatIfPresent(sourcePath);
  if (!sourceStat?.isFile() || sourceStat.size === 0) {
    throw new Error("Source must be an existing, non-empty regular file.");
  }
  if (await lstatIfPresent(destinationPath)) {
    throw new Error("Destination already exists.");
  }

  const destinationParent = path.dirname(destinationPath);
  const parentStat = await lstatIfPresent(destinationParent);
  if (!parentStat?.isDirectory()) {
    throw new Error("Destination parent must be an existing directory.");
  }

  const stagingDirectory = await mkdtemp(
    path.join(destinationParent, ".goosey-sqlite-backup-"),
  );
  const stagedBackup = path.join(stagingDirectory, "snapshot.sqlite");

  try {
    await chmod(stagingDirectory, 0o700);
    await runSqlite([
      "-readonly",
      sourcePath,
      `VACUUM INTO ${sqlLiteral(stagedBackup)};`,
    ]);

    const stagedStat = await lstatIfPresent(stagedBackup);
    if (!stagedStat?.isFile() || stagedStat.size === 0) {
      throw new Error("SQLite did not produce a valid backup file.");
    }
    await chmod(stagedBackup, 0o600);

    const integrityOutput = await runSqlite([
      "-readonly",
      stagedBackup,
      "PRAGMA integrity_check;",
    ]);
    if (integrityOutput !== "ok\n" && integrityOutput !== "ok\r\n") {
      throw new Error("SQLite backup integrity check failed.");
    }

    await fsyncFile(stagedBackup);
    const digest = await hashFile(stagedBackup);

    // A hard link is an atomic, exclusive publication on the destination's
    // filesystem. It cannot overwrite an existing path, including a symlink.
    await link(stagedBackup, destinationPath);
    await fsyncFile(destinationParent);

    return { path: destinationPath, ...digest };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
