export type VisiblePollingOptions = {
  run: (signal: AbortSignal) => Promise<void>;
  onError: (error: unknown) => void;
  isPaused: () => boolean;
  intervalMs?: number;
  maxIntervalMs?: number;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window?: Pick<Window, "addEventListener" | "removeEventListener">;
};

const DEFAULT_INTERVAL_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const TIMEOUT = Symbol("visible-polling-timeout");

function abortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Start non-overlapping polling that yields while its page is not actionable. */
export function startVisiblePolling(options: VisiblePollingOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxIntervalMs = Math.min(options.maxIntervalMs ?? MAX_BACKOFF_MS, MAX_BACKOFF_MS);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs > MAX_BACKOFF_MS) {
    throw new RangeError("intervalMs must be between 1 and 30000 milliseconds.");
  }
  if (!Number.isFinite(maxIntervalMs) || maxIntervalMs < intervalMs) {
    throw new RangeError("maxIntervalMs must be at least intervalMs and at most 30000 milliseconds.");
  }

  const documentTarget = options.document ??
    (typeof globalThis.document === "undefined" ? undefined : globalThis.document);
  const windowTarget = options.window ??
    (typeof globalThis.window === "undefined" ? undefined : globalThis.window);
  const isHidden = () => documentTarget?.visibilityState === "hidden";
  let stopped = false;
  let active = false;
  let followUpRequested = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;
  let cancelActiveForHidden: (() => void) | undefined;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delayMs);
  };

  const nextDelay = (): number =>
    Math.min(intervalMs * 2 ** failures, maxIntervalMs);

  const poll = async (): Promise<void> => {
    if (stopped || active) return;
    if (isHidden() || options.isPaused()) {
      schedule(intervalMs);
      return;
    }

    active = true;
    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    let hiddenCancellation = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(TIMEOUT);
      }, REQUEST_TIMEOUT_MS);
    });
    const cancelForHidden = () => {
      hiddenCancellation = true;
      if (timeout !== undefined) clearTimeout(timeout);
      controller.abort();
    };
    cancelActiveForHidden = cancelForHidden;

    try {
      await Promise.race([
        Promise.resolve().then(() => controller.signal.aborted ? undefined : options.run(controller.signal)),
        timeoutPromise,
      ]);
      if (!hiddenCancellation) failures = 0;
    } catch (error) {
      if (stopped || hiddenCancellation) return;
      if (timedOut || error === TIMEOUT) {
        failures += 1;
        options.onError(new Error("Polling request timed out."));
      } else if (!abortError(error)) {
        failures += 1;
        options.onError(error);
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (activeController === controller) activeController = undefined;
      if (cancelActiveForHidden === cancelForHidden) cancelActiveForHidden = undefined;
      active = false;
      if (!stopped && !isHidden()) {
        if (followUpRequested) {
          followUpRequested = false;
          schedule(0);
        } else {
          schedule(failures === 0 ? intervalMs : nextDelay());
        }
      }
    }
  };

  const promptRefresh = (): void => {
    if (stopped) return;
    if (isHidden()) {
      followUpRequested = false;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      // Keep active until run settles cooperatively; returning to the page
      // queues one refresh rather than overlapping cancellation cleanup.
      cancelActiveForHidden?.();
      return;
    }
    if (active) {
      followUpRequested = true;
      return;
    }
    schedule(0);
  };

  documentTarget?.addEventListener("visibilitychange", promptRefresh);
  windowTarget?.addEventListener("focus", promptRefresh);
  windowTarget?.addEventListener("online", promptRefresh);
  schedule(0);

  return () => {
    if (stopped) return;
    stopped = true;
    followUpRequested = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    documentTarget?.removeEventListener("visibilitychange", promptRefresh);
    windowTarget?.removeEventListener("focus", promptRefresh);
    windowTarget?.removeEventListener("online", promptRefresh);
    cancelActiveForHidden?.();
    cancelActiveForHidden = undefined;
    activeController?.abort();
    activeController = undefined;
  };
}
