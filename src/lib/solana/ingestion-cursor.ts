import { address, signature } from "@solana/kit";
import type { SolanaIngestionCursor } from "@prisma/client";
import { runSerializableTransaction, type TransactionRunner, type DatabaseProvider } from "../serializable-transaction";
import { persistFinalizedProgramReceipt } from "./event-journal";

type Receipt = Parameters<typeof persistFinalizedProgramReceipt>[1];
export type IngestionDomain = { genesisHash: string; programAddress: string };
export type IngestionCursorOptions = { client?: TransactionRunner; provider?: DatabaseProvider };
const MAX_REVISION = 2_147_483_647;
const MAX_SLOT = (1n << 63n) - 1n;
export const MAX_INGESTION_PAGE_RECEIPTS = 1000;

/** INTERNAL trusted page result, never an API request DTO. The worker must verify
 * finalized signature-page completeness/order and read EVERY receipt before
 * calling this service. Receipt objects alone cannot prove no signatures were
 * omitted. There is no RPC or page authenticity verification in a DB transaction.
 * Pages are newest-first; completing pages INCLUDE the target receipt (the
 * initial coverage boundary or previously committed head). If an RPC excludes
 * its `until` anchor, the worker must fetch/verify that anchor separately.
 */
export type VerifiedIngestionPage = IngestionDomain & {
  expectedRevision: number;
  expectedBeforeSignature: string | null;
  scanHeadSignature: string;
  nextBeforeSignature: string | null;
  reachedTarget: boolean;
  receipts: readonly Receipt[];
};

function domain(input: IngestionDomain): IngestionDomain {
  return { genesisHash: address(input.genesisHash), programAddress: address(input.programAddress) };
}
function revision(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_REVISION) throw new Error("Invalid ingestion cursor revision");
}
function nullableSignature(value: string | null) {
  if (value !== null) signature(value);
}
async function connection(options: IngestionCursorOptions) {
  if (options.client) return options.client;
  const { db, requireDatabaseStartup } = await import("../db");
  await requireDatabaseStartup();
  return db;
}
function assertCursor(cursor: SolanaIngestionCursor) {
  revision(cursor.revision);
  signature(cursor.coverageStartSignature);
  nullableSignature(cursor.committedHeadSignature);
  nullableSignature(cursor.scanHeadSignature);
  nullableSignature(cursor.scanBeforeSignature);
  if ((cursor.scanHeadSignature === null) !== (cursor.scanBeforeSignature === null)
    || cursor.backfillComplete !== (cursor.committedHeadSignature !== null)) {
    throw new Error("Inconsistent stored ingestion cursor");
  }
}

/** Idempotent only for the SAME immutable explicit inclusive coverage boundary. */
export async function initializeIngestionCursor(input: IngestionDomain & { coverageStartSignature: string },
  options: IngestionCursorOptions = {}) {
  const key = domain(input), coverageStartSignature = signature(input.coverageStartSignature);
  const settings = { ...options };
  const client = await connection(settings);
  return runSerializableTransaction(client, async tx => {
    const cursor = await tx.solanaIngestionCursor.upsert({
      where: { genesisHash_programAddress: key }, update: {}, create: { ...key, coverageStartSignature },
    });
    if (cursor.coverageStartSignature !== coverageStartSignature) throw new Error("Ingestion coverage boundary is immutable");
    assertCursor(cursor);
    return cursor;
  }, { provider: settings.provider });
}

export async function readIngestionCursor(input: IngestionDomain, options: IngestionCursorOptions = {}) {
  const key = domain(input), settings = { ...options };
  const client = await connection(settings);
  return runSerializableTransaction(client, async tx => {
    const cursor = await tx.solanaIngestionCursor.findUnique({ where: { genesisHash_programAddress: key } });
    if (cursor) assertCursor(cursor);
    return cursor;
  }, { provider: settings.provider });
}

export async function commitVerifiedIngestionPage(input: VerifiedIngestionPage, options: IngestionCursorOptions = {}) {
  // Detach nested event payloads as well as the array before the first await/retry.
  const page = structuredClone(input), key = domain(page), settings = { ...options };
  revision(page.expectedRevision);
  signature(page.scanHeadSignature);
  nullableSignature(page.expectedBeforeSignature);
  nullableSignature(page.nextBeforeSignature);
  if (typeof page.reachedTarget !== "boolean" || !Array.isArray(page.receipts)
    || page.receipts.length > MAX_INGESTION_PAGE_RECEIPTS) throw new Error("Invalid verified ingestion page");
  const seen = new Set<string>();
  let previousSlot: bigint | undefined;
  for (const receipt of page.receipts) {
    signature(receipt.signature);
    if (receipt.genesisHash !== key.genesisHash || receipt.programAddress !== key.programAddress) throw new Error("Receipt domain mismatch");
    if (typeof receipt.slot !== "bigint" || receipt.slot < 0n || receipt.slot > MAX_SLOT
      || typeof receipt.configurationSlot !== "bigint" || receipt.configurationSlot < receipt.slot
      || receipt.configurationSlot > MAX_SLOT) throw new Error("Invalid signed-range receipt slot");
    if (seen.has(receipt.signature) || receipt.signature === page.expectedBeforeSignature
      || (previousSlot !== undefined && receipt.slot > previousSlot)) throw new Error("Invalid receipt page order");
    seen.add(receipt.signature);
    previousSlot = receipt.slot;
  }
  const client = await connection(settings);
  return runSerializableTransaction(client, async tx => {
    const cursor = await tx.solanaIngestionCursor.findUniqueOrThrow({ where: { genesisHash_programAddress: key } });
    assertCursor(cursor);
    if (cursor.revision !== page.expectedRevision || cursor.scanBeforeSignature !== page.expectedBeforeSignature) {
      throw new Error("Stale ingestion cursor revision or before signature");
    }
    const target = cursor.committedHeadSignature ?? cursor.coverageStartSignature;
    if (cursor.scanHeadSignature !== null && cursor.scanHeadSignature !== page.scanHeadSignature) throw new Error("Ingestion scan head is frozen");
    if (page.receipts.length === 0) {
      if (!cursor.backfillComplete || cursor.scanHeadSignature !== null || !page.reachedTarget
        || page.scanHeadSignature !== cursor.committedHeadSignature || page.nextBeforeSignature !== null) {
        throw new Error("Empty page cannot advance ingestion coverage");
      }
      return { cursor, insertedReceipts: 0, noOp: true };
    }
    if (cursor.revision === MAX_REVISION) throw new Error("Ingestion cursor revision overflow");
    const first = page.receipts[0], last = page.receipts[page.receipts.length - 1];
    if (cursor.scanHeadSignature === null && first.signature !== page.scanHeadSignature) throw new Error("First page must start at scan head");
    if (cursor.scanHeadSignature !== null && seen.has(page.scanHeadSignature)) throw new Error("Repeated ingestion scan head");
    if (page.reachedTarget) {
      if (last.signature !== target || page.nextBeforeSignature !== null) throw new Error("Completing page must include its target receipt");
    } else if (seen.has(target) || page.nextBeforeSignature !== last.signature) {
      throw new Error("Nonterminal page must stop before target at its last receipt");
    }
    // The prior page tail is durable evidence of continuity and descending slot order.
    if (cursor.scanBeforeSignature !== null) {
      const before = await tx.solanaTransactionReceipt.findUniqueOrThrow({
        where: { genesisHash_programAddress_signature: { ...key, signature: cursor.scanBeforeSignature } },
      });
      if (first.slot > before.slot) throw new Error("Ingestion page regresses beyond previous tail");
    }
    let insertedReceipts = 0;
    for (const receipt of page.receipts) {
      const visit = { ...key, scanHeadSignature: page.scanHeadSignature, signature: receipt.signature };
      const previousVisit = await tx.solanaIngestionVisit.findUnique({
        where: { genesisHash_programAddress_scanHeadSignature_signature: visit },
      });
      if (previousVisit) throw new Error("Repeated signature in frozen ingestion scan");
      const result = await persistFinalizedProgramReceipt(tx, receipt);
      if (result.inserted) insertedReceipts++;
      await tx.solanaIngestionVisit.create({ data: visit });
    }
    const updated = await tx.solanaIngestionCursor.updateMany({
      where: { id: cursor.id, revision: page.expectedRevision, scanBeforeSignature: page.expectedBeforeSignature,
        scanHeadSignature: cursor.scanHeadSignature, committedHeadSignature: cursor.committedHeadSignature,
        coverageStartSignature: cursor.coverageStartSignature, backfillComplete: cursor.backfillComplete },
      data: { revision: { increment: 1 },
        scanHeadSignature: page.reachedTarget ? null : page.scanHeadSignature,
        scanBeforeSignature: page.reachedTarget ? null : page.nextBeforeSignature,
        ...(page.reachedTarget ? { committedHeadSignature: page.scanHeadSignature, backfillComplete: true } : {}),
      },
    });
    if (updated.count !== 1) throw new Error("Ingestion cursor compare-and-swap conflict");
    return { cursor: await tx.solanaIngestionCursor.findUniqueOrThrow({ where: { id: cursor.id } }), insertedReceipts, noOp: false };
  }, { provider: settings.provider });
}
