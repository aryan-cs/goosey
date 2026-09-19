import { createSolanaRpc, signature, type Signature } from "@solana/kit";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

export type SignaturePageRpc = Pick<ReturnType<typeof createSolanaRpc>, "getGenesisHash" | "getSlot" | "getSignaturesForAddress">;
export type SignaturePageEntry = Readonly<{ signature: Signature; slot: bigint }>;
export type SignaturePageInput = Readonly<{
  before?: string;
  targetSignature: string;
  /** false: prior committed head (exclusive); true: explicit initial boundary (inclusive). */
  includeTarget: boolean;
  limit?: number;
  /** Persisted root floor from an earlier page, when available. */
  minContextSlot?: bigint;
  /** Previous page's oldest slot, for a cross-page nonincreasing-slot check. */
  beforeSlot?: bigint;
}>;
export class SignatureHistoryGapError extends Error {
  readonly code = "SIGNATURE_HISTORY_GAP";
  constructor(readonly targetSignature: Signature) {
    super("Signature history ended before the explicit coverage target; coverage is incomplete");
    this.name = "SignatureHistoryGapError";
  }
}
function slot(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 64n) throw new Error("Invalid signature-page slot");
}
// Status metadata is not execution evidence and is never used to skip failed
// signatures. Only bound/check its JSON envelope; the receipt reader verifies it.
function boundedError(value: unknown, depth = 0): void {
  if (depth > 4) throw new Error("Excessive signature status nesting");
  if (value === null) return;
  if (typeof value === "string" && value.length <= 256) return;
  if (typeof value === "number" && Number.isSafeInteger(value)) return;
  if (typeof value === "bigint" && value >= 0n && value <= 0xffff_ffffn) return;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length > 4 || keys.some(key => key.length > 64)) throw new Error("Excessive signature status fields");
    for (const child of Object.values(value)) boundedError(child, depth + 1);
    return;
  }
  throw new Error("Malformed signature status metadata");
}

/** One read-only discovery page, not proof of execution or historical coverage.
 * Always inspect the target itself (no RPC `until`, which could hide it). RPC
 * returns no response context here: minContextSlot guards node freshness, and
 * pre/post finalized roots bound receipt slots; they do not pin a snapshot.
 * Freeze firstPageNewestSignature in the worker for the WHOLE scan. Later pages
 * return null for that field, never a replacement head. Preserve RPC same-slot
 * order solely for opaque cursor traversal, never as intra-slot execution order.
 * This stateless helper detects duplicates within a page and repetition of its
 * supplied cursor. The durable worker must also reject cycles/duplicates against
 * ALL previously persisted pages. No cursor is written or advanced here.
 * Transport owns HTTP body bounds; this helper bounds parsed page/field sizes.
 */
export async function readFinalizedSignaturePage(runtime: SolanaRuntime, input: SignaturePageInput,
  options: { rpc?: SignaturePageRpc; signal?: AbortSignal } = {}) {
  const pinned = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: runtime.cluster, GOOSEY_SOLANA_RPC_URL: runtime.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: runtime.programAddress, GOOSEY_SOLANA_GENESIS_HASH: runtime.genesisHash });
  if (runtime.genesisHash !== pinned.genesisHash) throw new Error("Explicit runtime genesis pin required");
  const before = input.before === undefined ? undefined : signature(input.before);
  const target = signature(input.targetSignature), includeTarget = input.includeTarget, limit = input.limit === undefined ? 25 : input.limit;
  const minimum = input.minContextSlot, ceiling = input.beforeSlot;
  if (typeof includeTarget !== "boolean" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid signature page boundary/limit");
  if (before === target) throw new Error("Before cursor already equals coverage target");
  if (minimum !== undefined) slot(minimum);
  if (ceiling !== undefined) { slot(ceiling); if (!before) throw new Error("beforeSlot requires before cursor"); }
  const signal = options.signal ?? AbortSignal.timeout(15_000), rpc = options.rpc ?? createSolanaRpc(pinned.rpcUrl);
  signal.throwIfAborted();
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== pinned.genesisHash) throw new Error("Signature RPC genesis mismatch");
  const rootBefore = await rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: signal });
  slot(rootBefore);
  if (minimum !== undefined && rootBefore < minimum) throw new Error("Signature RPC root below prior context floor");
  signal.throwIfAborted();
  const page = await rpc.getSignaturesForAddress(pinned.programAddress, {
    commitment: "finalized", limit, minContextSlot: rootBefore, ...(before ? { before } : {}),
  }).send({ abortSignal: signal });
  if (!Array.isArray(page) || page.length > limit) throw new Error("Invalid/excessive signature page");
  const entries: SignaturePageEntry[] = [], seen = new Set<Signature>();
  let previous = ceiling, targetIndex = -1;
  for (const item of page) {
    if (!item || typeof item !== "object" || item.confirmationStatus !== "finalized") throw new Error("Malformed/nonfinalized signature entry");
    const key = signature(item.signature); slot(item.slot);
    if (seen.has(key) || key === before) throw new Error("Duplicate signature or repeated before cursor");
    if (previous !== undefined && item.slot > previous) throw new Error("Signature slots are not nonincreasing");
    if (item.blockTime !== null && (typeof item.blockTime !== "bigint" || item.blockTime < -(1n << 63n) || item.blockTime >= 1n << 63n)) throw new Error("Malformed signature block time");
    if (item.memo !== null && (typeof item.memo !== "string" || item.memo.length > 1024 || new TextEncoder().encode(item.memo).length > 1024)) throw new Error("Excessive/malformed signature memo");
    if (item.err !== null && (typeof item.err !== "string" && (typeof item.err !== "object" || !item.err))) throw new Error("Malformed signature execution status");
    boundedError(item.err);
    seen.add(key); previous = item.slot;
    if (key === target) targetIndex = entries.length;
    entries.push(Object.freeze({ signature: key, slot: item.slot }));
  }
  const rootAfter = await rpc.getSlot({ commitment: "finalized" }).send({ abortSignal: signal });
  slot(rootAfter);
  if (rootAfter < rootBefore || entries.some(entry => entry.slot > rootAfter)) throw new Error("Invalid/regressing finalized signature root");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== pinned.genesisHash) throw new Error("Signature RPC genesis changed during page read");
  signal.throwIfAborted();
  const reachedTarget = targetIndex !== -1;
  if (!reachedTarget && page.length < limit) throw new SignatureHistoryGapError(target);
  return Object.freeze({ programAddress: pinned.programAddress, genesisHash: pinned.genesisHash,
    entries: Object.freeze(reachedTarget ? entries.slice(0, targetIndex + (includeTarget ? 1 : 0)) : entries),
    firstPageNewestSignature: before === undefined ? entries[0]?.signature ?? null : null,
    nextBefore: reachedTarget ? null : entries.at(-1)!.signature,
    reachedTarget, finalizedRoot: rootAfter });
}
