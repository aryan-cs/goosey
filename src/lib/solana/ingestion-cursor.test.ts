import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { address, getBase58Decoder, signature } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitVerifiedIngestionPage, initializeIngestionCursor, readIngestionCursor,
  type VerifiedIngestionPage } from "./ingestion-cursor";
import { persistFinalizedProgramReceipt } from "./event-journal";

// Real disposable SQLite persistence tests. Receipt fixtures are NOT RPC proof.
const execute = promisify(execFile);
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const genesisHash = "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm";
const domain = { genesisHash, programAddress };
const sig = (seed: number) => signature(getBase58Decoder().decode(new Uint8Array(64).fill(seed)));
const target = sig(1), tail = sig(2), head = sig(3), newerHead = sig(4);
let directory: string;
let client: PrismaClient;
const options = () => ({ client, provider: "sqlite" as const });
function receipt(transactionSignature = head, slot = 30n): VerifiedIngestionPage["receipts"][number] {
  return { ...domain, signature: transactionSignature, slot, config: programAddress, configurationSlot: 100n,
    outcome: "success", records: [{ status: "known", logIndex: 1, invocationDepth: 1,
      eventKey: `${genesisHash}:${programAddress}:${transactionSignature}:1`,
      event: { kind: "ResolutionFinalized", market: programAddress, residualMilli: 100n } }] };
}
function page(overrides: Partial<VerifiedIngestionPage> = {}): VerifiedIngestionPage {
  return { ...domain, expectedRevision: 0, expectedBeforeSignature: null, scanHeadSignature: head,
    nextBeforeSignature: tail, reachedTarget: false, receipts: [receipt(), receipt(tail, 20n)], ...overrides };
}
const initialize = () => initializeIngestionCursor({ ...domain, coverageStartSignature: target }, options());
const commit = (value = page()) => commitVerifiedIngestionPage(value, options());
const read = () => readIngestionCursor(domain, options());
const finish = () => commit(page({ expectedRevision: 1, expectedBeforeSignature: tail,
  nextBeforeSignature: null, reachedTarget: true, receipts: [receipt(target, 10n)] }));
async function counts() {
  return [await client.solanaTransactionReceipt.count(), await client.solanaProgramEvent.count()];
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-ingestion-cursor-"));
  const database = join(directory, "test.db");
  const sql = await readFile("prisma/sqlite-upgrades/20260919220000_solana_event_journal.sql", "utf8")
    + await readFile("prisma/sqlite-upgrades/20260919230000_solana_ingestion_visits.sql", "utf8");
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", database, `PRAGMA foreign_keys=ON;\n${sql}`]);
  client = new PrismaClient({ datasourceUrl: `file:${database}` });
});
afterEach(async () => {
  await client?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("durable internal verified-page ingestion cursor", () => {
  it("initializes idempotently, isolates domains and preserves immutable coverage", async () => {
    expect(await read()).toBeNull();
    const initial = await initialize();
    expect(initial).toMatchObject({ ...domain, coverageStartSignature: target, revision: 0,
      backfillComplete: false, committedHeadSignature: null, scanHeadSignature: null, scanBeforeSignature: null });
    expect(await initialize()).toEqual(initial);
    await expect(initializeIngestionCursor({ ...domain, coverageStartSignature: tail }, options())).rejects.toThrow("immutable");
    await initializeIngestionCursor({ ...domain, programAddress: genesisHash, coverageStartSignature: tail }, options());
    expect(await client.solanaIngestionCursor.count()).toBe(2);
    expect(await counts()).toEqual([0, 0]);
  });

  it("freezes head, resumes after reconnect, completes backfill then commits an incremental window", async () => {
    await initialize();
    expect(await commit()).toMatchObject({ insertedReceipts: 2, noOp: false, cursor: {
      revision: 1, scanHeadSignature: head, scanBeforeSignature: tail, committedHeadSignature: null, backfillComplete: false } });
    await client.$disconnect();
    client = new PrismaClient({ datasourceUrl: `file:${join(directory, "test.db")}` });
    expect(await read()).toMatchObject({ revision: 1, scanHeadSignature: head, scanBeforeSignature: tail });
    expect(await finish()).toMatchObject({ insertedReceipts: 1, cursor: { revision: 2,
      committedHeadSignature: head, backfillComplete: true, scanHeadSignature: null, scanBeforeSignature: null } });
    expect(await commit(page({ expectedRevision: 2, scanHeadSignature: newerHead, nextBeforeSignature: null,
      reachedTarget: true, receipts: [receipt(newerHead, 40n), receipt()] })))
      .toMatchObject({ insertedReceipts: 1, cursor: { revision: 3, committedHeadSignature: newerHead,
        coverageStartSignature: target, backfillComplete: true } });
    expect(await counts()).toEqual([4, 4]);
    expect(await client.solanaIngestionVisit.count()).toBe(5);
  });

  it("permits an unchanged empty up-to-date page without revision or timestamp mutation", async () => {
    await initialize(); await commit(); await finish();
    const before = await read();
    const result = await commit(page({ expectedRevision: 2, receipts: [], reachedTarget: true, nextBeforeSignature: null }));
    expect(result).toEqual({ cursor: before, insertedReceipts: 0, noOp: true });
    expect(await read()).toEqual(before);
  });

  it.each(["initial", "ongoing", "new-head"])("rejects empty advancing %s pages", async state => {
    await initialize();
    let value = page({ receipts: [], reachedTarget: true, nextBeforeSignature: null });
    if (state === "ongoing") { await commit(); value = { ...value, expectedRevision: 1, expectedBeforeSignature: tail }; }
    if (state === "new-head") { await commit(); await finish(); value = { ...value, expectedRevision: 2, scanHeadSignature: newerHead }; }
    const before = await read(), totals = await counts();
    await expect(commit(value)).rejects.toThrow("Empty page");
    expect(await read()).toEqual(before); expect(await counts()).toEqual(totals);
  });

  it.each(["revision", "before", "head", "slot-regression"])("rejects stale/invalid continuation %s", async change => {
    await initialize(); await commit();
    const value = page({ expectedRevision: 1, expectedBeforeSignature: tail, nextBeforeSignature: null,
      reachedTarget: true, receipts: [receipt(target, 10n)] });
    if (change === "revision") value.expectedRevision = 0;
    if (change === "before") value.expectedBeforeSignature = head;
    if (change === "head") value.scanHeadSignature = newerHead;
    if (change === "slot-regression") value.receipts[0].slot = 21n;
    const before = await read();
    await expect(commit(value)).rejects.toThrow();
    expect(await read()).toEqual(before); expect(await counts()).toEqual([2, 2]);
  });

  it.each(["head", "tail", "missing-target", "unmarked-target", "duplicate", "ascending", "domain"])("rejects malformed page %s atomically", async change => {
    await initialize();
    const value = page();
    if (change === "head") value.scanHeadSignature = newerHead;
    if (change === "tail") value.nextBeforeSignature = newerHead;
    if (change === "missing-target") { value.reachedTarget = true; value.nextBeforeSignature = null; }
    if (change === "unmarked-target") { value.receipts = [receipt(), receipt(target, 10n)]; value.nextBeforeSignature = target; }
    if (change === "duplicate") value.receipts = [receipt(), receipt()];
    if (change === "ascending") value.receipts[1].slot = 31n;
    if (change === "domain") value.receipts[1].genesisHash = programAddress;
    await expect(commit(value)).rejects.toThrow();
    expect(await counts()).toEqual([0, 0]); expect((await read())?.revision).toBe(0);
  });

  it("allows same-slot distinct signatures and all verified terminal zero-event outcomes", async () => {
    await initialize();
    const receipts = [receipt(), receipt(tail), receipt(target)];
    receipts.forEach((item, index) => { item.records = []; item.outcome = (["success", "failed", "no-program-invocation"] as const)[index]; });
    await commit(page({ receipts, reachedTarget: true, nextBeforeSignature: null }));
    expect(await counts()).toEqual([3, 0]);
    expect((await client.solanaTransactionReceipt.findMany()).map(r => r.status).sort())
      .toEqual(["VERIFIED_FAILED", "VERIFIED_NOT_INVOKED", "VERIFIED_SUCCESS"]);
    expect((await read())?.committedHeadSignature).toBe(head);
  });

  it("rolls back earlier receipts when a later receipt fails validation", async () => {
    await initialize();
    const value = page(); value.receipts[1].records[0].eventKey = "wrong-key";
    await expect(commit(value)).rejects.toThrow("identity mismatch");
    expect(await counts()).toEqual([0, 0]); expect((await read())?.revision).toBe(0);
    expect(await client.solanaIngestionVisit.count()).toBe(0);
  });

  it("rolls back an incremental receipt when the boundary replay conflicts", async () => {
    await initialize(); await commit(); await finish();
    const badAnchor = receipt(); badAnchor.records = [];
    const before = await read();
    await expect(commit(page({ expectedRevision: 2, scanHeadSignature: newerHead, receipts: [receipt(newerHead, 40n), badAnchor],
      reachedTarget: true, nextBeforeSignature: null }))).rejects.toThrow("Conflicting immutable");
    expect(await counts()).toEqual([3, 3]); expect(await read()).toEqual(before);
  });

  it("rolls back receipts/events when the actual database rejects cursor CAS", async () => {
    await initialize();
    // Test-only DB trigger forces a zero-row CAS, without mocking the transaction.
    await client.$executeRawUnsafe(`CREATE TRIGGER reject_cursor_update BEFORE UPDATE ON "SolanaIngestionCursor"
      BEGIN SELECT RAISE(IGNORE); END;`);
    await expect(commit()).rejects.toThrow("compare-and-swap");
    expect(await counts()).toEqual([0, 0]); expect((await read())?.revision).toBe(0);
    expect(await client.solanaIngestionVisit.count()).toBe(0);
  });

  it("rejects reapplying the same committed page without duplicating receipts", async () => {
    await initialize(); await commit();
    await expect(commit()).rejects.toThrow("Stale ingestion");
    expect(await counts()).toEqual([2, 2]); expect((await read())?.revision).toBe(1);
  });

  it.each([-1, 1.5, 2147483648, NaN])("rejects invalid revision %s", async expectedRevision => {
    await initialize(); await expect(commit(page({ expectedRevision }))).rejects.toThrow("revision");
    expect(await counts()).toEqual([0, 0]);
  });

  it("rejects revision increment overflow before writing receipts", async () => {
    await initialize();
    await client.solanaIngestionCursor.updateMany({ data: { revision: 2147483647 } });
    await expect(commit(page({ expectedRevision: 2147483647 }))).rejects.toThrow("overflow");
    expect(await counts()).toEqual([0, 0]);
  });

  it.each([-1n, 1n << 63n])("rejects signed-range overflow %s in either slot field", async slot => {
    await initialize();
    for (const field of ["slot", "configurationSlot"] as const) {
      const value = page(); value.receipts[0][field] = slot;
      await expect(commit(value)).rejects.toThrow("signed-range");
    }
    expect(await counts()).toEqual([0, 0]);
  });

  it.each(["genesisHash", "programAddress", "coverageStartSignature"] as const)("rejects invalid initialization %s", async field => {
    const value: { genesisHash: string; programAddress: string; coverageStartSignature: string } = { ...domain, coverageStartSignature: target }; value[field] = "invalid";
    await expect(initializeIngestionCursor(value, options())).rejects.toThrow();
    expect(await client.solanaIngestionCursor.count()).toBe(0);
  });

  it.each(["scanHeadSignature", "expectedBeforeSignature", "nextBeforeSignature"] as const)("rejects invalid page signature %s", async field => {
    await initialize(); await expect(commit(page({ [field]: "invalid" }))).rejects.toThrow();
    expect(await counts()).toEqual([0, 0]);
  });

  it("copies nested inputs before awaiting connection/transaction work", async () => {
    await initialize(); const value = page();
    const pending = commit(value);
    value.scanHeadSignature = newerHead;
    value.receipts[0].records[0].eventKey = "mutated";
    value.receipts[1].slot = -1n;
    expect(await pending).toMatchObject({ insertedReceipts: 2, cursor: { scanHeadSignature: head } });
  });

  it("rejects durable same-slot cross-page cycles [A,B] -> [C,D] -> [B,E] after reconnect", async () => {
    await initialize();
    const c = sig(5), d = sig(6), e = sig(7);
    await commit(page({ receipts: [receipt(), receipt(tail)] }));
    await commit(page({ expectedRevision: 1, expectedBeforeSignature: tail,
      nextBeforeSignature: d, receipts: [receipt(c), receipt(d)] }));
    const before = await read();
    await client.$disconnect();
    client = new PrismaClient({ datasourceUrl: `file:${join(directory, "test.db")}` });
    await expect(commit(page({ expectedRevision: 2, expectedBeforeSignature: d,
      nextBeforeSignature: e, receipts: [receipt(tail), receipt(e)] }))).rejects.toThrow("Repeated signature");
    expect(await read()).toEqual(before); expect(await counts()).toEqual([4, 4]);
    expect(await client.solanaIngestionVisit.count()).toBe(4);
    // Also roll back a newly inserted receipt/visit preceding the repeated member.
    await expect(commit(page({ expectedRevision: 2, expectedBeforeSignature: d,
      nextBeforeSignature: tail, receipts: [receipt(e), receipt(tail)] }))).rejects.toThrow("Repeated signature");
    expect(await counts()).toEqual([4, 4]); expect(await client.solanaIngestionVisit.count()).toBe(4);
  });

  it("accepts pre-ingested receipts without mistaking journal presence for scan membership", async () => {
    await initialize();
    await client.$transaction(tx => persistFinalizedProgramReceipt(tx, receipt()));
    expect(await client.solanaIngestionVisit.count()).toBe(0);
    expect(await commit()).toMatchObject({ insertedReceipts: 1, cursor: { revision: 1 } });
    expect(await counts()).toEqual([2, 2]); expect(await client.solanaIngestionVisit.count()).toBe(2);
  });

  it("enforces scan membership uniqueness at the database boundary", async () => {
    await initialize(); await commit();
    const data = { ...domain, scanHeadSignature: head, signature: tail };
    await expect(client.solanaIngestionVisit.create({ data })).rejects.toThrow(/Unique constraint/);
    await client.solanaIngestionVisit.create({ data: { ...data, scanHeadSignature: newerHead } });
    await client.solanaIngestionVisit.create({ data: { ...data, genesisHash: programAddress } });
    expect(await client.solanaIngestionVisit.count()).toBe(4);
  });

  it.each(["sqlite", "postgresql"])("matches the second %s migration to schema-generated visit DDL", async provider => {
    const schema = provider === "sqlite" ? "prisma/schema.prisma" : "prisma/postgresql/schema.prisma";
    const migration = provider === "sqlite" ? "prisma/sqlite-upgrades/20260919230000_solana_ingestion_visits.sql"
      : "prisma/postgresql/migrations/20260919230000_solana_ingestion_visits/migration.sql";
    const { stdout } = await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff",
      "--from-empty", "--to-schema-datamodel", schema, "--script"], { maxBuffer: 4 * 1024 * 1024 });
    const statements = stdout.split(";").filter(part => /(?:CREATE TABLE "SolanaIngestionVisit"|CREATE UNIQUE INDEX "SolanaVisit_domain_scan_signature_key")/.test(part));
    const normalize = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
    expect(normalize(await readFile(migration, "utf8"))).toBe(normalize(`${statements.join(";")};`));
  });

  it("applies the second migration without modifying published journal rows", async () => {
    await initialize(); await commit();
    // Recreate only the new table on this private test DB to exercise ALTER-free upgrade preservation.
    await client.$executeRawUnsafe('DROP TABLE "SolanaIngestionVisit"');
    const before = { cursor: await read(), receipts: await client.solanaTransactionReceipt.findMany({ orderBy: { id: "asc" } }),
      events: await client.solanaProgramEvent.findMany({ orderBy: { eventKey: "asc" } }) };
    const sql = await readFile("prisma/sqlite-upgrades/20260919230000_solana_ingestion_visits.sql", "utf8");
    await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", join(directory, "test.db"), `BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`]);
    expect({ cursor: await read(), receipts: await client.solanaTransactionReceipt.findMany({ orderBy: { id: "asc" } }),
      events: await client.solanaProgramEvent.findMany({ orderBy: { eventKey: "asc" } }) }).toEqual(before);
    expect(await client.solanaIngestionVisit.count()).toBe(0);
  });
});
