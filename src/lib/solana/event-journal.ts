import { address, signature } from "@solana/kit";
import type { Prisma } from "@prisma/client";
import { runSerializableTransaction, type TransactionRunner, type DatabaseProvider } from "../serializable-transaction";
import { readFinalizedProgramEvents, type ProgramEventReadRpc } from "./program-event-read";
import { PROGRAM_EVENT_LIMITS } from "./program-events";
import type { SolanaRuntime } from "./runtime";

type Receipt = Awaited<ReturnType<typeof readFinalizedProgramEvents>>;
const MAX_SLOT = (1n << 63n) - 1n;
const statuses = { success: "VERIFIED_SUCCESS", failed: "VERIFIED_FAILED", "no-program-invocation": "VERIFIED_NOT_INVOKED" } as const;
function slot(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value > MAX_SLOT) throw new Error("Journal slot exceeds signed database range");
  return value;
}
function payload(value: object) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    (_, item: unknown) => typeof item === "bigint" ? item.toString() : item);
}

/** Internal persistence boundary for already verified reader results. No RPC
 * runs inside the transaction. This only writes journal tables, never monetary
 * balances. Do not expose this function to untrusted API request bodies.
 * Duplicate immutable content must match exactly; newer configurationSlot is
 * not execution history and does not rewrite the original observation.
 */
export async function persistFinalizedProgramReceipt(tx: Prisma.TransactionClient, input: Receipt) {
  address(input.genesisHash); address(input.programAddress); signature(input.signature);
  const domain = { genesisHash: input.genesisHash, programAddress: input.programAddress, signature: input.signature };
  const transactionSlot = slot(input.slot), configurationSlot = slot(input.configurationSlot);
  if (configurationSlot < transactionSlot || !Object.hasOwn(statuses, input.outcome)) throw new Error("Invalid verified receipt context");
  if (input.records.length > PROGRAM_EVENT_LIMITS.logs || (input.outcome !== "success" && input.records.length)) throw new Error("Invalid receipt event count");
  const status = statuses[input.outcome];
  let lastLogIndex = -1;
  const events = input.records.map(record => {
    if (record.status !== "known" || !Number.isInteger(record.logIndex) || record.logIndex <= lastLogIndex
      || record.logIndex >= PROGRAM_EVENT_LIMITS.logs || !Number.isInteger(record.invocationDepth)
      || record.invocationDepth < 1 || record.invocationDepth > PROGRAM_EVENT_LIMITS.depth) throw new Error("Invalid journal event position");
    lastLogIndex = record.logIndex;
    if (record.eventKey !== `${domain.genesisHash}:${domain.programAddress}:${domain.signature}:${record.logIndex}`) throw new Error("Journal event identity mismatch");
    const encoded = payload(record.event);
    if (new TextEncoder().encode(encoded).length > PROGRAM_EVENT_LIMITS.lineBytes) throw new Error("Journal payload exceeds bound");
    return { eventKey: record.eventKey, logIndex: record.logIndex, invocationDepth: record.invocationDepth,
      kind: record.event.kind, payload: encoded, schemaVersion: 1,
      marketAddress: "market" in record.event ? address(record.event.market) : null,
      walletAddress: "wallet" in record.event ? address(record.event.wallet) : null };
  });
  const previous = await tx.solanaTransactionReceipt.findUnique({
    where: { genesisHash_programAddress_signature: domain }, include: { events: { orderBy: { logIndex: "asc" } } },
  });
  if (previous) {
    const same = previous.slot === transactionSlot && previous.status === status && previous.decoderVersion === 1
      && previous.eventCount === events.length && previous.events.length === events.length
      && previous.events.every((event, index) => Object.entries(events[index]).every(([key, value]) => event[key as keyof typeof event] === value));
    if (!same) throw new Error("Conflicting immutable Solana journal replay");
    return { receiptId: previous.id, inserted: false, eventCount: events.length };
  }
  const created = await tx.solanaTransactionReceipt.create({ data: {
    ...domain, slot: transactionSlot, configurationSlot, status, eventCount: events.length, decoderVersion: 1,
    events: { create: events },
  } });
  return { receiptId: created.id, inserted: true, eventCount: events.length };
}

/** Read one actual finalized transaction, then commit its receipt and events
 * atomically. Cursor advancement is intentionally separate: one receipt does
 * not prove an entire signature window has been covered.
 */
export async function ingestFinalizedProgramTransaction(runtime: SolanaRuntime, transactionSignature: string,
  options: { rpc?: ProgramEventReadRpc; signal?: AbortSignal; client?: TransactionRunner; provider?: DatabaseProvider } = {}) {
  const { rpc, signal, client, provider } = options;
  const receipt = await readFinalizedProgramEvents(runtime, transactionSignature, { rpc, signal });
  signal?.throwIfAborted();
  let connection = client;
  if (!connection) {
    const { db, requireDatabaseStartup } = await import("../db");
    await requireDatabaseStartup(); connection = db;
  }
  const result = await runSerializableTransaction(connection, tx => persistFinalizedProgramReceipt(tx, receipt), { provider });
  return { ...result, outcome: receipt.outcome, signature: receipt.signature, slot: receipt.slot };
}
