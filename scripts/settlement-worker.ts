import { db, requireDatabaseStartup } from "../src/lib/db";
import { settlementWorkerCycleFailed } from "../src/lib/settlement-worker-result";
import {
  heartbeatSettlementWorker,
  registerSettlementWorker,
  runSettlementWorkerCycle,
  stopSettlementWorker,
} from "../src/lib/settlement-worker-service";

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 10_000;

function positiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

const continuous = process.argv.includes("--continuous");
const intervalArgument = process.argv.find((argument) => argument.startsWith("--interval-ms="))?.split("=", 2)[1];
const intervalMs = positiveInteger(intervalArgument, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
let stopping = false;
let wakeSleep: (() => void) | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    wakeSleep?.();
  });
}

async function interruptibleDelay(milliseconds: number): Promise<void> {
  if (stopping) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeSleep = null;
      resolve();
    }, milliseconds);
    wakeSleep = () => {
      clearTimeout(timer);
      wakeSleep = null;
      resolve();
    };
  });
}

async function main(): Promise<void> {
  await requireDatabaseStartup();
  const instanceId = await registerSettlementWorker();
  try {
    do {
      if (stopping) break;
      const summary = await runSettlementWorkerCycle({ instanceId, shouldStop: () => stopping });
      console.log(JSON.stringify({ event: "settlement_worker_cycle", ...summary, at: new Date().toISOString() }));
      if (!continuous) {
        if (settlementWorkerCycleFailed(summary)) process.exitCode = 1;
        return;
      }
      await interruptibleDelay(intervalMs);
      if (!stopping) await heartbeatSettlementWorker(instanceId);
    } while (!stopping);
  } finally {
    await stopSettlementWorker(instanceId).catch(() => undefined);
  }
}

void main()
  .catch((error) => {
    console.error(JSON.stringify({
      level: "fatal",
      event: "settlement_worker_stopped",
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
    process.exitCode = 1;
  })
  .finally(async () => { await db.$disconnect(); });
