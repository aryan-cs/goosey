import { signature, type createSolanaRpc } from "@solana/kit";

export type TransactionStatus = "submitted" | "confirmed" | "finalized" | "failed" | "expired" | "unknown";
export type TransactionStatusRpc = Pick<ReturnType<typeof createSolanaRpc>, "getSignatureStatuses" | "getBlockHeight">;
export type TransactionStatusResult = {
  status: TransactionStatus;
  signature: string;
  commitment?: "processed" | "confirmed" | "finalized";
  /** Slot reported for this exact signature observation. Finalized results can
   * use it as the lower bound for post-transaction account verification. */
  executionSlot?: bigint;
  error?: unknown;
  /** Expiration proves the signed bytes cannot land now, not that an earlier
   * execution did not happen (RPC history may have been pruned). */
  historicalOutcome?: "unknown";
};
export type TrackTransactionInput = {
  signature: string;
  lastValidBlockHeight: bigint;
  commitment?: "confirmed" | "finalized";
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onObservation?: (observation: TransactionStatusResult) => void;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatus(response: unknown) {
  if (!record(response) || !record(response.context) || typeof response.context.slot !== "bigint"
    || response.context.slot < 0n || !Array.isArray(response.value) || response.value.length !== 1) {
    throw new Error("Malformed signature status response");
  }
  const item: unknown = response.value[0];
  if (item === null) return { contextSlot: response.context.slot, item: null };
  if (!record(item) || typeof item.slot !== "bigint" || item.slot < 0n
    || !(item.confirmations === null || (typeof item.confirmations === "bigint" && item.confirmations >= 0n))
    || !(item.confirmationStatus === null || item.confirmationStatus === "processed"
      || item.confirmationStatus === "confirmed" || item.confirmationStatus === "finalized")
    || !(item.err === null || typeof item.err === "string" || (record(item.err) && Object.keys(item.err).length > 0))) {
    throw new Error("Malformed signature status");
  }
  return { contextSlot: response.context.slot, item: {
    slot: item.slot,
    commitment: item.confirmationStatus as "processed" | "confirmed" | "finalized" | null,
    error: item.err,
  } };
}

// Race cancellation even if a broken/custom transport ignores its abort signal.
function abortable<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Read-only tracker for recent-blockhash transactions, not durable nonce transactions.
 * `submitted` is a caller report, not proof of landing. Confirmed observations can
 * disappear on a fork. Unknown is not a failure and must not trigger a newly signed
 * replacement: a sender may retransmit the SAME signed bytes/signature while valid.
 * This tracker never sends, signs, or mutates accounting. RPC trust is required.
 */
export async function trackTransactionStatus(
  rpc: TransactionStatusRpc,
  input: TrackTransactionInput,
): Promise<TransactionStatusResult> {
  const sig = signature(input.signature);
  const commitment = input.commitment ?? "finalized";
  const timeoutMs = input.timeoutMs ?? 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  if (typeof input.lastValidBlockHeight !== "bigint" || input.lastValidBlockHeight < 0n
    || !["confirmed", "finalized"].includes(commitment)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 2_147_483_647) {
    throw new Error("Invalid transaction tracking options");
  }
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const callerAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", callerAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(new Error("Tracking deadline reached")), timeoutMs);
  const signal = controller.signal;
  const result = (status: TransactionStatus, extra: Partial<TransactionStatusResult> = {}): TransactionStatusResult =>
    ({ ...extra, signature: sig, status });
  const read = async () => parseStatus(await abortable(
    rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send({ abortSignal: signal }), signal,
  ));
  const classify = (item: ReturnType<typeof parseStatus>["item"]): TransactionStatusResult => {
    if (!item?.commitment) return result("unknown");
    const reached = item.commitment === "finalized" || (commitment === "confirmed" && item.commitment === "confirmed");
    if (item.error !== null) return result(reached ? "failed" : "unknown", {
      commitment: item.commitment,
      executionSlot: item.slot,
      error: item.error,
    });
    return result(item.commitment === "processed" ? "submitted" : item.commitment, {
      commitment: item.commitment,
      executionSlot: item.slot,
    });
  };
  try {
    input.onObservation?.(result("submitted"));
    while (!signal.aborted) {
      let observation: TransactionStatusResult;
      try {
        let response = await read();
        if (response.item === null) {
          // Status context is the node's current (processed) bank, even when
          // the signature is absent. Finality normally lags it by ~32 slots.
          // Using that moving slot as a finalized minContextSlot can starve
          // expiry forever. A finalized height is sufficient: stale heights
          // can only delay expiry. Re-read status below before classifying it.
          const height = await abortable(rpc.getBlockHeight({
            commitment: "finalized",
          }).send({ abortSignal: signal }), signal);
          if (typeof height !== "bigint" || height < 0n) throw new Error("Malformed block height");
          if (height > input.lastValidBlockHeight) {
            const refreshed = await read();
            if (refreshed.contextSlot < response.contextSlot) throw new Error("Stale status response");
            response = refreshed;
            if (response.item === null) return result("expired", { historicalOutcome: "unknown" });
          }
        }
        observation = classify(response.item);
      } catch {
        if (signal.aborted) break;
        observation = result("unknown");
      }
      input.onObservation?.(observation);
      input.signal?.throwIfAborted();
      if (observation.status === "failed" || observation.status === "finalized"
        || (commitment === "confirmed" && observation.status === "confirmed")) return observation;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await abortable(new Promise<void>((resolve) => { timer = setTimeout(resolve, pollIntervalMs); }), signal);
      } catch { break; }
      finally { clearTimeout(timer); }
    }
    input.signal?.throwIfAborted();
    return result("unknown");
  } finally {
    clearTimeout(deadline);
    input.signal?.removeEventListener("abort", callerAbort);
  }
}
