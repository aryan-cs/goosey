import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startVisiblePolling } from "./visible-polling";

class EventSurface {
  visibilityState: DocumentVisibilityState = "visible";
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    },
  );

  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      this.listeners.get(type)?.delete(listener);
    },
  );

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(new Event(type));
      else listener.handleEvent(new Event(type));
    }
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("startVisiblePolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("skips hidden pages and retries at the base interval", async () => {
    const document = new EventSurface();
    document.visibilityState = "hidden";
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startVisiblePolling({
      run,
      onError: vi.fn(),
      isPaused: () => false,
      intervalMs: 100,
      document: document as never,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    document.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledOnce();
    stop();
  });

  it("yields while paused and resumes on a prompt event", async () => {
    const window = new EventSurface();
    let paused = true;
    const run = vi.fn().mockResolvedValue(undefined);
    const stop = startVisiblePolling({
      run,
      onError: vi.fn(),
      isPaused: () => paused,
      intervalMs: 100,
      window: window as never,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
    paused = false;
    window.dispatch("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    stop();
  });

  it("never overlaps runs and coalesces active prompts into one follow-up", async () => {
    const window = new EventSurface();
    const first = deferred();
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const stop = startVisiblePolling({
      run,
      onError: vi.fn(),
      isPaused: () => false,
      intervalMs: 100,
      window: window as never,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledOnce();
    window.dispatch("focus");
    window.dispatch("online");
    window.dispatch("focus");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();

    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("aborts active work, removes listeners, and suppresses abort errors on cleanup", async () => {
    const document = new EventSurface();
    const window = new EventSurface();
    const onError = vi.fn();
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const stop = startVisiblePolling({
      run,
      onError,
      isPaused: () => false,
      intervalMs: 100,
      document: document as never,
      window: window as never,
    });

    await vi.advanceTimersByTimeAsync(0);
    const signal = run.mock.calls[0]![0];
    stop();
    await Promise.resolve();

    expect(signal.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(document.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(window.removeEventListener).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(window.removeEventListener).toHaveBeenCalledWith("online", expect.any(Function));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledOnce();
  });

  it("backs off after errors up to the configured cap and resets after success", async () => {
    const onError = vi.fn();
    const failure = new Error("offline");
    const run = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const stop = startVisiblePolling({
      run,
      onError,
      isPaused: () => false,
      intervalMs: 100,
      maxIntervalMs: 250,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(199);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(249);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(99);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(4);
    stop();
  });

  it("times out hung work after ten seconds, reports stale data, and retries", async () => {
    const onError = vi.fn();
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const stop = startVisiblePolling({
      run,
      onError,
      isPaused: () => false,
      intervalMs: 100,
      maxIntervalMs: 200,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.mock.calls[0]![0].aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Polling request timed out." }));
    await vi.advanceTimersByTimeAsync(199);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("quietly aborts a hidden in-flight request and resumes without cancellation backoff", async () => {
    const document = new EventSurface();
    const onError = vi.fn();
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("fetch canceled while hidden")), { once: true });
    }));
    const stop = startVisiblePolling({ run, onError, isPaused: () => false, intervalMs: 100, document: document as never });
    await vi.advanceTimersByTimeAsync(0);
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    expect(run.mock.calls[0]![0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    run.mockResolvedValue(undefined);
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for cooperative cancellation to finish when the page returns before completion", async () => {
    const document = new EventSurface();
    const window = new EventSurface();
    const cancellation = deferred();
    const onError = vi.fn();
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const run = vi.fn(async (signal: AbortSignal) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (++calls === 1) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          await cancellation.promise;
          throw new DOMException("Aborted", "AbortError");
        }
      } finally { concurrent -= 1; }
    });
    const stop = startVisiblePolling({ run, onError, isPaused: () => false, intervalMs: 100, document: document as never, window: window as never });
    await vi.advanceTimersByTimeAsync(0);
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    window.dispatch("focus");
    window.dispatch("online");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    cancellation.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    document.dispatch("visibilitychange");
    window.dispatch("focus");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cleans up while hidden cancellation is still settling without scheduling another run", async () => {
    const document = new EventSurface();
    const first = deferred();
    const run = vi.fn((signal: AbortSignal) => {
      signal.throwIfAborted();
      return first.promise;
    });
    const onError = vi.fn();
    const stop = startVisiblePolling({ run, onError, isPaused: () => false, document: document as never });
    await vi.advanceTimersByTimeAsync(0);
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    stop();
    expect(run.mock.calls[0]![0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    first.resolve();
    document.visibilityState = "visible";
    document.dispatch("visibilitychange");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
