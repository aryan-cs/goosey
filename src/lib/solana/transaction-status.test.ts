import { afterEach, describe, expect, it, vi } from "vitest";
import { trackTransactionStatus, type TransactionStatusRpc } from "./transaction-status";

// Mocked RPC contract tests only; these are not validator/on-chain proof.
const sig = "1".repeat(64);
const input = { signature: sig, lastValidBlockHeight: 100n, timeoutMs: 50, pollIntervalMs: 10 };
const response = (commitment: string | null, err: unknown = null) => ({
  context: { slot: 500n }, value: [{ slot: 499n, confirmations: commitment === "finalized" ? null : 1n,
    confirmationStatus: commitment, err }],
});
const absent = { context: { slot: 500n }, value: [null] };
function mock(statuses: unknown[], height: unknown = 99n) {
  let index = 0;
  const statusSend = vi.fn(async () => {
    const value = statuses[Math.min(index++, statuses.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  });
  const getSignatureStatuses = vi.fn(() => ({ send: statusSend }));
  const getBlockHeight = vi.fn(() => ({ send: vi.fn(async () => height) }));
  return { rpc: { getSignatureStatuses, getBlockHeight } as unknown as TransactionStatusRpc,
    getSignatureStatuses, getBlockHeight, statusSend };
}
async function finish<T>(promise: Promise<T>) {
  await vi.advanceTimersByTimeAsync(60);
  return promise;
}
afterEach(() => vi.useRealTimers());

describe("signed transaction tracking", () => {
  it("observes submitted then confirmed but waits for finalized by default", async () => {
    vi.useFakeTimers();
    const m = mock([response("processed"), response("confirmed"), response("finalized")]);
    const onObservation = vi.fn();
    expect(await finish(trackTransactionStatus(m.rpc, { ...input, onObservation })))
      .toMatchObject({ status: "finalized", executionSlot: 499n });
    expect(onObservation.mock.calls.map(([value]) => value.status)).toEqual(["submitted", "submitted", "confirmed", "finalized"]);
    for (const args of m.getSignatureStatuses.mock.calls) expect(args).toEqual([[sig], { searchTransactionHistory: true }]);
    expect(m.getBlockHeight).not.toHaveBeenCalled();
  });

  it("supports explicit confirmed commitment", async () => {
    expect((await trackTransactionStatus(mock([response("confirmed")]).rpc, { ...input, commitment: "confirmed" })).status).toBe("confirmed");
  });

  it("reports a finalized execution error as failed", async () => {
    const error = { InstructionError: [0, { Custom: 1 }] };
    expect(await trackTransactionStatus(mock([response("finalized", error)]).rpc, input))
      .toMatchObject({ status: "failed", executionSlot: 499n, error });
  });

  it("does not make a provisional fork error terminal", async () => {
    vi.useFakeTimers();
    const m = mock([response("confirmed", "AccountNotFound"), response("finalized")]);
    expect((await finish(trackTransactionStatus(m.rpc, input))).status).toBe("finalized");
  });

  it("does not retain confirmed success after a reorg or deadline", async () => {
    vi.useFakeTimers();
    expect((await finish(trackTransactionStatus(mock([response("confirmed"), absent]).rpc, input))).status).toBe("unknown");
    expect((await finish(trackTransactionStatus(mock([response("confirmed")], 101n).rpc, input))).status).toBe("unknown");
  });

  it("expires only beyond last valid height, with a second absent status read", async () => {
    const m = mock([absent], 101n);
    expect(await trackTransactionStatus(m.rpc, input)).toMatchObject({ status: "expired", historicalOutcome: "unknown" });
    expect(m.statusSend).toHaveBeenCalledTimes(2);
    expect(m.getBlockHeight).toHaveBeenCalledWith({ commitment: "finalized" });
    vi.useFakeTimers();
    expect((await finish(trackTransactionStatus(mock([absent], 100n).rpc, input))).status).toBe("unknown");
  });

  it("does not require the finalized bank to catch a moving processed status context", async () => {
    const m = mock([absent], 101n);
    const getBlockHeight = vi.fn((options: { minContextSlot?: bigint }) => ({ send: async () => {
      if (options.minContextSlot !== undefined && options.minContextSlot > 468n) throw new Error("Minimum context slot has not been reached");
      return 101n;
    } }));
    const rpc = { ...m.rpc, getBlockHeight } as unknown as TransactionStatusRpc;
    expect(await trackTransactionStatus(rpc, input)).toMatchObject({ status: "expired", historicalOutcome: "unknown" });
    expect(getBlockHeight).toHaveBeenCalledTimes(1);
  });

  it("handles landing between height/status reads without false expiration", async () => {
    expect((await trackTransactionStatus(mock([absent, response("finalized")], 101n).rpc, input)).status).toBe("finalized");
  });

  it.each([
    new Error("RPC offline"), {}, { context: { slot: 500n }, value: [] },
    { context: { slot: 500n }, value: [{ slot: 499n, confirmations: null, confirmationStatus: "finalized" }] },
    response(null), response("bad"), response("finalized", false),
  ])("does not manufacture success from malformed/missing/error status %#", async (status) => {
    vi.useFakeTimers();
    expect((await finish(trackTransactionStatus(mock([status]).rpc, input))).status).toBe("unknown");
  });

  it("rejects stale expiration confirmation and malformed heights", async () => {
    vi.useFakeTimers();
    const stale = { context: { slot: 499n }, value: [null] };
    const m = mock([absent, stale], 101n);
    m.statusSend.mockImplementation(async () => m.statusSend.mock.calls.length % 2 ? absent : stale);
    expect((await finish(trackTransactionStatus(m.rpc, input))).status).toBe("unknown");
    expect((await finish(trackTransactionStatus(mock([absent], 101).rpc, input))).status).toBe("unknown");
  });

  it("bounds a transport that never completes even when it ignores cancellation", async () => {
    vi.useFakeTimers();
    const m = mock([absent]);
    m.statusSend.mockImplementation(() => new Promise(() => {}));
    expect((await finish(trackTransactionStatus(m.rpc, input))).status).toBe("unknown");
    expect(m.statusSend).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation before and during tracking without a failure result", async () => {
    const controller = new AbortController();
    const m = mock([absent]);
    m.statusSend.mockImplementation(() => new Promise(() => {}));
    const pending = trackTransactionStatus(m.rpc, { ...input, signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow("User canceled");
    controller.abort(new Error("User canceled"));
    await assertion;
    await expect(trackTransactionStatus(m.rpc, { ...input, signal: controller.signal })).rejects.toThrow("User canceled");
    expect(m.statusSend).toHaveBeenCalledTimes(1);
  });

  it("validates signature and finite bounded options before querying", async () => {
    const m = mock([absent]);
    for (const patch of [{ signature: "bad" }, { timeoutMs: Infinity }, { pollIntervalMs: 0 }, { lastValidBlockHeight: -1n }]) {
      await expect(trackTransactionStatus(m.rpc, { ...input, ...patch })).rejects.toThrow();
    }
    expect(m.statusSend).not.toHaveBeenCalled();
  });
});
