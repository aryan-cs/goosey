import { randomUUID } from "node:crypto";

import { db, requireDatabaseStartup } from "../src/lib/db";
import {
  managedCommandWorkerConfigFromEnvironment,
  runManagedCommandWorker,
} from "../src/lib/solana/managed-command-worker";

const controller = new AbortController();
const stop = () => controller.abort();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);

async function main(): Promise<void> {
  await requireDatabaseStartup();
  const config = managedCommandWorkerConfigFromEnvironment();
  await runManagedCommandWorker({
    signal: controller.signal,
    owner: `managed-chain-${randomUUID()}`,
    ...config,
    onCycle: summary => {
      console.log(JSON.stringify({ event: "managed_chain_worker_cycle", ...summary, at: new Date().toISOString() }));
    },
    onCycleError: event => {
      console.error(JSON.stringify({ level: "error", event: "managed_chain_worker_cycle_failed",
        ...event, at: new Date().toISOString() }));
    },
  });
}

void main()
  .catch(error => {
    console.error(JSON.stringify({ level: "fatal", event: "managed_chain_worker_stopped",
      errorType: error instanceof Error ? error.name : "UnknownError" }));
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, stop);
    await db.$disconnect();
  });
