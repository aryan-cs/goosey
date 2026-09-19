import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { address, signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistFinalizedProgramReceipt } from "./event-journal";
import type { readFinalizedProgramEvents } from "./program-event-read";

// Persistence fixtures, not real-chain receipt evidence. Each test uses an
// actual disposable SQLite database; no participant database is touched.
const execute = promisify(execFile);
type Receipt = Awaited<ReturnType<typeof readFinalizedProgramEvents>>;
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const txSignature = signature("6M2a2q9v4ePtvpQhsPHesZwQDeaHzJfQ9kzgacadhv1fsBb1b4WAiZXv83vxDAH3fmPjE6bfRsioJ4hA3afnDi3");
let directory: string;
let client: PrismaClient;
function fixture(): Receipt {
  return { signature: txSignature, slot: 50n, genesisHash, programAddress, config: programAddress,
    configurationSlot: 60n, outcome: "success", records: [{ status: "known", logIndex: 1, invocationDepth: 1,
      eventKey: `${genesisHash}:${programAddress}:${txSignature}:1`,
      event: { kind: "ResolutionFinalized", market: programAddress, residualMilli: (1n << 64n) - 1n } }] };
}
const save = (receipt = fixture()) => client.$transaction(tx => persistFinalizedProgramReceipt(tx, receipt));
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-journal-test-"));
  const database = join(directory, "test.db");
  const sql = await readFile(join(process.cwd(), "prisma/sqlite-upgrades/20260919220000_solana_event_journal.sql"), "utf8");
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", database, `PRAGMA foreign_keys=ON;\n${sql}`]);
  client = new PrismaClient({ datasourceUrl: `file:${database}` });
});
afterEach(async () => {
  await client?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("atomic immutable finalized event journal", () => {
  it("stores u64 payloads losslessly and replays without duplicates", async () => {
    const first = await save();
    expect(first).toMatchObject({ inserted: true, eventCount: 1 });
    expect(await save()).toEqual({ ...first, inserted: false });
    const receipt = await client.solanaTransactionReceipt.findFirstOrThrow({ include: { events: true } });
    expect(receipt.status).toBe("VERIFIED_SUCCESS");
    expect(receipt.events[0].payload).toBe(`{"kind":"ResolutionFinalized","market":"${programAddress}","residualMilli":"18446744073709551615"}`);
    expect(await client.solanaProgramEvent.count()).toBe(1);
  });
  it("does not rewrite historical observations when replay uses a newer snapshot", async () => {
    await save(); const newer = fixture(); newer.configurationSlot = 1000n;
    expect(await save(newer)).toMatchObject({ inserted: false });
    expect((await client.solanaTransactionReceipt.findFirstOrThrow()).configurationSlot).toBe(60n);
  });
  it.each(["success", "failed", "no-program-invocation"] as const)("persists zero-event terminal %s", async outcome => {
    const receipt = { ...fixture(), outcome, records: [] } as Receipt;
    expect(await save(receipt)).toMatchObject({ inserted: true, eventCount: 0 });
    expect(await save(receipt)).toMatchObject({ inserted: false });
    expect(await client.solanaProgramEvent.count()).toBe(0);
    expect((await client.solanaTransactionReceipt.findFirstOrThrow()).status).toBe({ success: "VERIFIED_SUCCESS", failed: "VERIFIED_FAILED", "no-program-invocation": "VERIFIED_NOT_INVOKED" }[outcome]);
  });
  it.each(["slot", "payload", "depth", "count", "outcome"])("rejects conflicting immutable %s replay", async change => {
    await save(); const receipt = fixture();
    if (change === "slot") receipt.slot = 51n;
    if (change === "payload" && receipt.records[0].event.kind === "ResolutionFinalized") receipt.records[0].event = { ...receipt.records[0].event, residualMilli: 2n };
    if (change === "depth") receipt.records[0].invocationDepth = 2;
    if (change === "count") receipt.records = [];
    if (change === "outcome") { receipt.outcome = "failed"; receipt.records = []; }
    await expect(save(receipt)).rejects.toThrow("Conflicting immutable");
    expect(await client.solanaProgramEvent.count()).toBe(1);
  });
  it("rolls back both receipt and events when the enclosing page transaction fails", async () => {
    await expect(client.$transaction(async tx => { await persistFinalizedProgramReceipt(tx, fixture()); throw new Error("page conflict"); })).rejects.toThrow("page conflict");
    expect(await client.solanaTransactionReceipt.count()).toBe(0);
    expect(await client.solanaProgramEvent.count()).toBe(0);
    expect(await client.solanaIngestionCursor.count()).toBe(0);
  });
  it.each([-1n, 1n << 63n])("rejects database slot overflow %s before writes", async value => {
    const receipt = fixture(); receipt.slot = value;
    await expect(save(receipt)).rejects.toThrow("signed database range");
    expect(await client.solanaTransactionReceipt.count()).toBe(0);
  });
  it("rejects duplicate positions and cross-domain event keys", async () => {
    const duplicate = fixture(); duplicate.records = [...duplicate.records, duplicate.records[0]];
    await expect(save(duplicate)).rejects.toThrow("position");
    const foreign = fixture(); foreign.records[0].eventKey = "foreign";
    await expect(save(foreign)).rejects.toThrow("identity mismatch");
    expect(await client.solanaTransactionReceipt.count()).toBe(0);
  });
  it("detects incomplete stored receipts instead of silently repairing immutable history", async () => {
    await save(); await client.solanaProgramEvent.deleteMany();
    await expect(save()).rejects.toThrow("Conflicting immutable");
  });
});
