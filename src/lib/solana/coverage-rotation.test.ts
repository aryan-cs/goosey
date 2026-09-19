import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { address, getBase58Decoder, signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readReceipt: vi.fn() }));
vi.mock("./program-event-read", async importOriginal => ({
  ...await importOriginal<typeof import("./program-event-read")>(),
  readFinalizedProgramEvents: mocks.readReceipt,
}));

import { coverageCursorSha256, inspectCoverageRotation, rotateCoverageBoundary } from "./coverage-rotation";
import { solanaIndexerWorkerIdentity } from "./indexer-health";

const execute = promisify(execFile);
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const wallet = address("9xQeWvG816bUx9EPfEZ6Xr52VY5G7aK6VhZfC4H7Z1Q9");
const enrollment = address("4Nd1mYw9Q6F9xL2a4yW8J9nW4g2kK4b7g8D1dQ5mX3zP");
const oldBoundary = signature(getBase58Decoder().decode(new Uint8Array(64).fill(1)));
const newBoundary = signature(getBase58Decoder().decode(new Uint8Array(64).fill(2)));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999/", genesisHash, programAddress };
let directory = "";
let client: PrismaClient;

function input(oldCursorSha256?: string) {
  return {
    runtime,
    newBoundarySignature: newBoundary,
    enrolledWalletAddress: wallet,
    reason: "The retained validator pruned the prior immutable boundary.",
    confirmations: { genesisHash, programAddress: programAddress.toString(), oldBoundarySignature: oldBoundary,
      newBoundarySignature: newBoundary, ...(oldCursorSha256 ? { oldCursorSha256 } : {}) },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-coverage-rotation-"));
  const database = join(directory, "test.db");
  const sql = await Promise.all([
    "prisma/sqlite-upgrades/20260919220000_solana_event_journal.sql",
    "prisma/sqlite-upgrades/20260919230000_solana_ingestion_visits.sql",
    "prisma/sqlite-upgrades/20260919234000_solana_coverage_rotations.sql",
  ].map(path => readFile(path, "utf8")));
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", database,
    `PRAGMA foreign_keys=ON;
    CREATE TABLE "WorkerState" (
      "id" TEXT NOT NULL PRIMARY KEY, "workerName" TEXT NOT NULL, "instanceId" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'STARTING', "startedAt" DATETIME NOT NULL,
      "lastHeartbeatAt" DATETIME NOT NULL, "lastCycleStartedAt" DATETIME,
      "lastCycleSucceededAt" DATETIME, "lastCycleFailedAt" DATETIME, "stoppedAt" DATETIME,
      "consecutiveFailures" INTEGER NOT NULL DEFAULT 0, "lastError" TEXT,
      "cycleCount" BIGINT NOT NULL DEFAULT 0, "successCount" BIGINT NOT NULL DEFAULT 0,
      "failureCount" BIGINT NOT NULL DEFAULT 0, "closedMarketCount" BIGINT NOT NULL DEFAULT 0,
      "completedRunCount" BIGINT NOT NULL DEFAULT 0, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX "WorkerState_workerName_key" ON "WorkerState"("workerName");
    ${sql.join("\n")}`]);
  client = new PrismaClient({ datasourceUrl: `file:${database}` });
  await client.solanaIngestionCursor.create({ data: { genesisHash, programAddress,
    coverageStartSignature: oldBoundary } });
  mocks.readReceipt.mockResolvedValue({
    signature: newBoundary, slot: 50n, genesisHash, programAddress,
    config: programAddress, configurationSlot: 60n, outcome: "success",
    records: [{ status: "known", logIndex: 7, invocationDepth: 1,
      eventKey: `${genesisHash}:${programAddress}:${newBoundary}:7`,
      event: { kind: "EnrollmentAuthorized", wallet, enrollment, allowance: 1_000n, expiresAt: 100n } }],
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  await client?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("explicit localnet ingestion coverage rotation", () => {
  it("inspects, atomically rotates, and retains an append-only exact cursor snapshot", async () => {
    const preview = await inspectCoverageRotation(input(), { client, provider: "sqlite" });
    expect(preview).toMatchObject({ oldCursor: { coverageStartSignature: oldBoundary, revision: 0 },
      newBoundary: { signature: newBoundary, slot: 50n, walletAddress: wallet }, fullHistory: false });
    expect(preview.oldCursorSha256).toBe(coverageCursorSha256(preview.oldCursor));

    const result = await rotateCoverageBoundary(input(preview.oldCursorSha256), {
      client, provider: "sqlite", id: "rotation-one",
    });
    expect(result).toMatchObject({ rotationId: "rotation-one", priorCursorSha256: preview.oldCursorSha256,
      newCursor: { coverageStartSignature: newBoundary, revision: 1, backfillComplete: false }, fullHistory: false });
    const audit = await client.solanaCoverageRotation.findUniqueOrThrow({ where: { id: "rotation-one" } });
    expect(audit).toMatchObject({ previousCoverageStartSignature: oldBoundary, previousRevision: 0,
      previousCursorSha256: preview.oldCursorSha256, newCoverageStartSignature: newBoundary,
      newBoundarySlot: 50n, newBoundaryConfigurationSlot: 60n, newBoundaryWalletAddress: wallet,
      newBoundaryEnrollmentAddress: enrollment });
    await expect(client.solanaCoverageRotation.update({ where: { id: audit.id }, data: { reason: "replacement reason" } }))
      .rejects.toThrow();
    await expect(client.solanaCoverageRotation.delete({ where: { id: audit.id } })).rejects.toThrow();
    expect(await client.solanaCoverageRotation.findUniqueOrThrow({ where: { id: audit.id } })).toEqual(audit);
  });

  it.each([
    ["deployment", (value: ReturnType<typeof input>) => ({ ...value, confirmations: { ...value.confirmations, genesisHash: programAddress } })],
    ["old boundary", (value: ReturnType<typeof input>) => ({ ...value, confirmations: { ...value.confirmations, oldBoundarySignature: newBoundary } })],
    ["new boundary", (value: ReturnType<typeof input>) => ({ ...value, confirmations: { ...value.confirmations, newBoundarySignature: oldBoundary } })],
    ["creator wallet", (value: ReturnType<typeof input>) => ({ ...value, enrolledWalletAddress: programAddress })],
  ])("rejects mismatched %s confirmation without changing cursor or audit", async (_name, mutate) => {
    const before = await client.solanaIngestionCursor.findFirstOrThrow();
    await expect(inspectCoverageRotation(mutate(input()), { client, provider: "sqlite" })).rejects.toThrow();
    expect(await client.solanaIngestionCursor.findFirstOrThrow()).toEqual(before);
    expect(await client.solanaCoverageRotation.count()).toBe(0);
  });

  it("requires the inspected full-cursor digest and fails closed on a concurrent cursor change", async () => {
    const preview = await inspectCoverageRotation(input(), { client, provider: "sqlite" });
    await expect(rotateCoverageBoundary(input(), { client, provider: "sqlite" })).rejects.toThrow(/SHA-256/);
    await client.solanaIngestionCursor.updateMany({ data: { revision: { increment: 1 } } });
    await expect(rotateCoverageBoundary(input(preview.oldCursorSha256), { client, provider: "sqlite" }))
      .rejects.toThrow(/changed after operator inspection/);
    expect(await client.solanaCoverageRotation.count()).toBe(0);
  });

  it("refuses active workers and any retained receipt or scan evidence", async () => {
    const preview = await inspectCoverageRotation(input(), { client, provider: "sqlite" });
    const worker = solanaIndexerWorkerIdentity(runtime);
    await client.workerState.create({ data: { id: worker.workerId, workerName: worker.workerName, instanceId: "instance",
      status: "RUNNING", startedAt: new Date(), lastHeartbeatAt: new Date() } });
    await expect(rotateCoverageBoundary(input(preview.oldCursorSha256), { client, provider: "sqlite" }))
      .rejects.toThrow(/Stop the continuous indexer/);
    await client.workerState.update({ where: { id: worker.workerId }, data: { status: "STOPPED", stoppedAt: new Date() } });
    await rotateCoverageBoundary(input(preview.oldCursorSha256), { client, provider: "sqlite", id: "allowed" });
    await client.solanaIngestionCursor.updateMany({ data: { coverageStartSignature: oldBoundary, revision: 2 } });
    await client.solanaTransactionReceipt.create({ data: { genesisHash, programAddress, signature: newBoundary,
      slot: 50n, configurationSlot: 60n, status: "VERIFIED_SUCCESS" } });
    const current = await client.solanaIngestionCursor.findFirstOrThrow();
    const currentSnapshot = { coverageStartSignature: current.coverageStartSignature,
      committedHeadSignature: current.committedHeadSignature, scanHeadSignature: current.scanHeadSignature,
      scanBeforeSignature: current.scanBeforeSignature, backfillComplete: current.backfillComplete,
      revision: current.revision, createdAt: current.createdAt.toISOString(), updatedAt: current.updatedAt.toISOString() };
    await expect(rotateCoverageBoundary(input(coverageCursorSha256(currentSnapshot)), { client, provider: "sqlite" }))
      .rejects.toThrow(/no retained domain receipts/);
    expect(await client.solanaCoverageRotation.count()).toBe(1);
  });

  it("never accepts devnet", async () => {
    await expect(inspectCoverageRotation({ ...input(), runtime: { ...runtime, cluster: "devnet" as const,
      rpcUrl: "https://api.devnet.solana.com", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" } },
    { client, provider: "sqlite" })).rejects.toThrow(/localnet-only/);
    expect(mocks.readReceipt).not.toHaveBeenCalled();
  });
});
