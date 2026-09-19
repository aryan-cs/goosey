import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient, type WorkerState } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const PROCESS_TIMEOUT_MS = 20_000;
const WAIT_TIMEOUT_MS = 8_000;
const MAX_CAPTURED_OUTPUT = 64 * 1024;

type ExitResult = { code: number | null; signal: NodeJS.Signals | null };
type WorkerProcess = {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<ExitResult>;
  output: () => { stdout: string; stderr: string };
};

const liveChildren = new Set<WorkerProcess>();
let directory = "";
let databasePath = "";
let database: PrismaClient | undefined;

function boundedAppend(current: string, chunk: Buffer): string {
  return (current + chunk.toString()).slice(-MAX_CAPTURED_OUTPUT);
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_PROVIDER: "sqlite",
    DATABASE_URL: `file:${databasePath}`,
    RATE_LIMIT_KEY_SECRET: "settlement-worker-process-test-isolated-key",
  };
  delete environment.POSTGRES_DATABASE_URL;
  delete environment.POSTGRES_DIRECT_DATABASE_URL;
  return environment;
}

function startWorker(): WorkerProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/settlement-worker.ts", "--continuous", "--interval-ms=1000"],
    {
      cwd: process.cwd(),
      env: workerEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = boundedAppend(stderr, chunk); });

  const exited = new Promise<ExitResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const lifetime = setTimeout(() => child.kill("SIGKILL"), PROCESS_TIMEOUT_MS);
  const worker: WorkerProcess = {
    child,
    exited,
    output: () => ({ stdout, stderr }),
  };
  void exited.then(
    () => {
      clearTimeout(lifetime);
      liveChildren.delete(worker);
    },
    () => {
      clearTimeout(lifetime);
      liveChildren.delete(worker);
    },
  );
  liveChildren.add(worker);
  return worker;
}

async function waitForExit(worker: WorkerProcess, timeoutMs = WAIT_TIMEOUT_MS): Promise<ExitResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const output = worker.output();
          reject(new Error(`Worker did not exit in time. stdout=${output.stdout} stderr=${output.stderr}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function waitForState(
  predicate: (state: WorkerState | null) => boolean,
  worker: WorkerProcess,
): Promise<WorkerState> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await database!.workerState.findUnique({ where: { id: "settlement" } });
    if (predicate(state)) return state!;
    const earlyExit = await Promise.race([
      worker.exited.then((result) => result),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    if (earlyExit) {
      const output = worker.output();
      throw new Error(
        `Worker exited before reaching expected state (${earlyExit.code}/${earlyExit.signal}). stdout=${output.stdout} stderr=${output.stderr}`,
      );
    }
  }
  const output = worker.output();
  throw new Error(`Worker state timed out. stdout=${output.stdout} stderr=${output.stderr}`);
}

async function stopWorker(worker: WorkerProcess): Promise<void> {
  if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
    await worker.exited.catch(() => undefined);
    return;
  }
  worker.child.kill("SIGTERM");
  try {
    await waitForExit(worker, 4_000);
  } catch {
    worker.child.kill("SIGKILL");
    await worker.exited.catch(() => undefined);
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-settlement-worker-process-"));
  databasePath = join(directory, "worker.db");
  await writeFile(databasePath, "");
  await execute(
    join(process.cwd(), "node_modules/.bin/prisma"),
    ["db", "push", "--schema", "prisma/schema.prisma", "--skip-generate"],
    {
      cwd: process.cwd(),
      env: workerEnvironment(),
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );
  database = new PrismaClient({ datasourceUrl: `file:${databasePath}` });
  await database.$connect();
  await database.user.create({
    data: {
      email: "settlement-worker-system@goosey.test",
      username: "settlement_worker_system",
      displayName: "Settlement worker system principal",
      passwordHash: "isolated-worker-process-fixture-only",
      role: "SYSTEM",
      status: "ACTIVE",
    },
  });
}, PROCESS_TIMEOUT_MS);

afterEach(async () => {
  for (const worker of [...liveChildren]) await stopWorker(worker);
  await database?.$disconnect();
  database = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
  databasePath = "";
}, PROCESS_TIMEOUT_MS);

describe("settlement worker process lifecycle", () => {
  it("heartbeats, stops gracefully, and allows a new process to take ownership", async () => {
    const first = startWorker();
    const firstRunning = await waitForState(
      (state) => state?.status === "RUNNING" && state.cycleCount >= 1n && state.lastCycleSucceededAt !== null,
      first,
    );

    first.child.kill("SIGTERM");
    await expect(waitForExit(first)).resolves.toEqual({ code: 0, signal: null });
    const firstStopped = await database!.workerState.findUniqueOrThrow({ where: { id: "settlement" } });
    expect(firstStopped).toMatchObject({ instanceId: firstRunning.instanceId, status: "STOPPED" });
    expect(firstStopped.stoppedAt).not.toBeNull();

    const restarted = startWorker();
    const restartedRunning = await waitForState(
      (state) =>
        state?.status === "RUNNING" &&
        state.instanceId !== firstRunning.instanceId &&
        state.cycleCount > firstRunning.cycleCount &&
        state.lastCycleSucceededAt !== null,
      restarted,
    );
    expect(restartedRunning.instanceId).not.toBe(firstRunning.instanceId);

    restarted.child.kill("SIGTERM");
    await expect(waitForExit(restarted)).resolves.toEqual({ code: 0, signal: null });
    await expect(database!.workerState.findUniqueOrThrow({ where: { id: "settlement" } })).resolves.toMatchObject({
      instanceId: restartedRunning.instanceId,
      status: "STOPPED",
    });
  }, PROCESS_TIMEOUT_MS);

  it("rejects a concurrent process without stopping the fresh owner", async () => {
    const owner = startWorker();
    const ownerState = await waitForState(
      (state) => state?.status === "RUNNING" && state.cycleCount >= 1n && state.lastCycleSucceededAt !== null,
      owner,
    );

    const contender = startWorker();
    await expect(waitForExit(contender)).resolves.toEqual({ code: 1, signal: null });
    expect(contender.output().stderr).toContain('"errorType":"SettlementWorkerAlreadyActiveError"');
    await expect(database!.workerState.findUniqueOrThrow({ where: { id: "settlement" } })).resolves.toMatchObject({
      instanceId: ownerState.instanceId,
      status: "RUNNING",
      stoppedAt: null,
    });

    owner.child.kill("SIGTERM");
    await expect(waitForExit(owner)).resolves.toEqual({ code: 0, signal: null });
    await expect(database!.workerState.findUniqueOrThrow({ where: { id: "settlement" } })).resolves.toMatchObject({
      instanceId: ownerState.instanceId,
      status: "STOPPED",
    });
  }, PROCESS_TIMEOUT_MS);
});
