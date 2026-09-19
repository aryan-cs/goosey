import { createSolanaRpc, signature } from "@solana/kit";
import { initializeIngestionCursor, commitVerifiedIngestionPage, type IngestionCursorOptions } from "./ingestion-cursor";
import { readFinalizedProgramEvents, type ProgramEventReadRpc } from "./program-event-read";
import { readFinalizedSignaturePage, type SignaturePageRpc } from "./signature-page";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

export type IngestionWorkerOptions = IngestionCursorOptions & {
  rpc?: ProgramEventReadRpc & SignaturePageRpc;
  signal?: AbortSignal;
  pageSize?: number;
  concurrency?: number;
};

/** One bounded resumable page. Discovery and every receipt read finish before
 * the atomic journal/cursor transaction. A missing receipt or history gap never
 * becomes a successful synchronization. Run again to resume; no timer, airdrop,
 * transaction submission or migration is hidden inside this function.
 */
export async function ingestFinalizedProgramPage(runtime: SolanaRuntime, coverageStartSignature: string,
  options: IngestionWorkerOptions = {}) {
  const pinned = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: runtime.cluster, GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash });
  const coverage = signature(coverageStartSignature);
  const { client, provider, pageSize = 25, concurrency = 4 } = options;
  const signal = options.signal ?? AbortSignal.timeout(60_000);
  const rpc = options.rpc ?? createSolanaRpc(pinned.rpcUrl);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Invalid ingestion page bounds");
  signal.throwIfAborted();
  const domain = { genesisHash: pinned.genesisHash, programAddress: pinned.programAddress };
  const cursor = await initializeIngestionCursor({ ...domain, coverageStartSignature: coverage }, { client, provider });
  signal.throwIfAborted();
  const page = await readFinalizedSignaturePage(pinned, {
    before: cursor.scanBeforeSignature ?? undefined,
    targetSignature: cursor.committedHeadSignature ?? coverage,
    // The cursor commit verifies the target receipt, including previously
    // committed heads. Immutable journal replay makes this safe and explicit.
    includeTarget: true, limit: pageSize,
  }, { rpc, signal });
  if (page.genesisHash !== domain.genesisHash || page.programAddress !== domain.programAddress) throw new Error("Signature page domain mismatch");
  const scanHead = cursor.scanHeadSignature ?? page.firstPageNewestSignature;
  if (!scanHead) throw new Error("Signature page has no frozen scan head");
  const idle = cursor.backfillComplete && cursor.scanHeadSignature === null && page.reachedTarget
    && page.entries.length === 1 && page.entries[0].signature === cursor.committedHeadSignature;
  const receipts: Awaited<ReturnType<typeof readFinalizedProgramEvents>>[] = new Array(idle ? 0 : page.entries.length);
  let next = 0;
  // Preserve discovery traversal order even when independent RPC reads finish
  // out of order. No assumption about execution order within a slot is made.
  const reads = new AbortController();
  const readSignal = AbortSignal.any([signal, reads.signal]);
  const pending = idle ? [] : Array.from({ length: Math.min(concurrency, page.entries.length) }, async () => {
    for (;;) {
      readSignal.throwIfAborted();
      const index = next++;
      if (index >= page.entries.length) return;
      const entry = page.entries[index];
      const receipt = await readFinalizedProgramEvents(pinned, entry.signature, { rpc, signal: readSignal });
      if (receipt.signature !== entry.signature || receipt.slot !== entry.slot
        || receipt.genesisHash !== domain.genesisHash || receipt.programAddress !== domain.programAddress) {
        throw new Error("Discovered signature does not match verified receipt");
      }
      receipts[index] = receipt;
    }
  });
  try { await Promise.all(pending); }
  catch (error) {
    reads.abort(error);
    await Promise.allSettled(pending);
    throw error;
  }
  signal.throwIfAborted();
  const committed = await commitVerifiedIngestionPage({ ...domain, expectedRevision: cursor.revision,
    expectedBeforeSignature: cursor.scanBeforeSignature, scanHeadSignature: scanHead,
    nextBeforeSignature: page.nextBefore, reachedTarget: page.reachedTarget, receipts,
  }, { client, provider });
  return { status: committed.noOp ? "idle" as const : page.reachedTarget ? "window-complete" as const : "page-committed" as const,
    ...committed, verifiedReceipts: receipts.length, finalizedRoot: page.finalizedRoot };
}
