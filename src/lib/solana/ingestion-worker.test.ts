import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { address, getBase58Decoder, signature } from "@solana/kit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestFinalizedProgramPage } from "./ingestion-worker";

const mock = vi.hoisted(() => ({ page: vi.fn(), receipt: vi.fn() }));
vi.mock("./signature-page", () => ({ readFinalizedSignaturePage: mock.page }));
vi.mock("./program-event-read", () => ({ readFinalizedProgramEvents: mock.receipt }));
// Mocked verified RPC boundaries, real SQLite journal+cursor transactions.
// This test is not actual-chain evidence. Separate RPC suites exercise readers.
const execute = promisify(execFile);
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const sig = (n: number) => signature(getBase58Decoder().decode(new Uint8Array(64).fill(n)));
const head = sig(3), tail = sig(2), boundary = sig(1);
let directory: string, schema: string, client: PrismaClient;
const options = () => ({ client, provider: "sqlite" as const });
const slot = (key: string) => key === head ? 30n : key === tail ? 20n : 10n;
function page(keys: string[], reachedTarget: boolean, first = true) {
  return { programAddress: runtime.programAddress, genesisHash: runtime.genesisHash,
    entries: keys.map(key => ({ signature: signature(key), slot: slot(key) })),
    reachedTarget, firstPageNewestSignature: first ? signature(keys[0]) : null,
    nextBefore: reachedTarget ? null : signature(keys.at(-1)!), finalizedRoot: 100n };
}
beforeAll(async () => {
  schema = (await execute(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "diff", "--from-empty",
    "--to-schema-datamodel", "prisma/schema.prisma", "--script"], { maxBuffer: 4 * 1024 * 1024 })).stdout;
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "goosey-ingestion-worker-"));
  const database = join(directory, "test.db");
  await execute("sqlite3", ["-batch", "-bail", "-init", "/dev/null", database, `PRAGMA foreign_keys=ON;\n${schema}`]);
  client = new PrismaClient({ datasourceUrl: `file:${database}` });
  mock.page.mockReset(); mock.receipt.mockReset();
  mock.receipt.mockImplementation(async (_runtime, key: string) => ({ signature: signature(key), slot: slot(key),
    genesisHash: runtime.genesisHash, programAddress: runtime.programAddress, config: runtime.programAddress,
    configurationSlot: 100n, outcome: "success", records: [] }));
});
afterEach(async () => { await client?.$disconnect(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe("bounded finalized ingestion orchestration", () => {
  it("resumes a partial window after reconnecting and reports idle without new writes", async () => {
    mock.page.mockResolvedValueOnce(page([head, tail], false));
    expect(await ingestFinalizedProgramPage(runtime, boundary, options())).toMatchObject({ status: "page-committed", verifiedReceipts: 2 });
    await client.$disconnect(); client = new PrismaClient({ datasourceUrl: `file:${join(directory, "test.db")}` });
    mock.page.mockResolvedValueOnce(page([boundary], true, false));
    expect(await ingestFinalizedProgramPage(runtime, boundary, options())).toMatchObject({ status: "window-complete", cursor: { committedHeadSignature: head, revision: 2 } });
    expect(mock.page.mock.calls[1][1]).toMatchObject({ before: tail, targetSignature: boundary, includeTarget: true });
    mock.page.mockResolvedValueOnce(page([head], true));
    expect(await ingestFinalizedProgramPage(runtime, boundary, options())).toMatchObject({ status: "idle", verifiedReceipts: 0, cursor: { revision: 2 } });
    expect(await client.solanaTransactionReceipt.count()).toBe(3);
    expect(await client.user.count()).toBe(0);
  });
  it("does not persist a partially read page when one receipt is unavailable", async () => {
    mock.page.mockResolvedValue(page([head, tail], false));
    mock.receipt.mockRejectedValueOnce(new Error("receipt pruned"));
    await expect(ingestFinalizedProgramPage(runtime, boundary, options())).rejects.toThrow("pruned");
    expect(await client.solanaTransactionReceipt.count()).toBe(0);
    expect(await client.solanaIngestionCursor.findFirst()).toMatchObject({ revision: 0, scanHeadSignature: null });
  });
  it("rejects a discovery/receipt slot mismatch without advancing", async () => {
    mock.page.mockResolvedValue(page([head], false));
    mock.receipt.mockImplementation(async () => ({ signature: head, slot: 99n, genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress, configurationSlot: 100n, outcome: "success", records: [] }));
    await expect(ingestFinalizedProgramPage(runtime, boundary, options())).rejects.toThrow("does not match");
    expect(await client.solanaTransactionReceipt.count()).toBe(0);
  });
  it("preserves verified failed receipts as terminal zero-event journal entries", async () => {
    mock.page.mockResolvedValue(page([boundary], true));
    mock.receipt.mockImplementation(async () => ({ signature: boundary, slot: 10n, genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress, configurationSlot: 100n, outcome: "failed", records: [] }));
    expect(await ingestFinalizedProgramPage(runtime, boundary, options())).toMatchObject({ status: "window-complete" });
    expect(await client.solanaTransactionReceipt.findFirst()).toMatchObject({ status: "VERIFIED_FAILED", eventCount: 0 });
  });
  it("does not turn a history gap into a completed backfill", async () => {
    mock.page.mockRejectedValue(new Error("coverage history gap"));
    await expect(ingestFinalizedProgramPage(runtime, boundary, options())).rejects.toThrow("gap");
    expect(await client.solanaIngestionCursor.findFirst()).toMatchObject({ revision: 0, backfillComplete: false });
  });
  it("rejects cancellation before discovery or database writes", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(ingestFinalizedProgramPage(runtime, boundary, { ...options(), signal: controller.signal })).rejects.toThrow();
    expect(mock.page).not.toHaveBeenCalled();
    expect(await client.solanaIngestionCursor.count()).toBe(0);
  });
});
