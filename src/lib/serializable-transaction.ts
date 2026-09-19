import { Prisma } from "@prisma/client";
import { resolveDatabaseRuntime, type DatabaseProvider } from "@/lib/database-runtime";

export type { DatabaseProvider } from "@/lib/database-runtime";

type TransactionClient = Prisma.TransactionClient;
type TransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

export interface TransactionRunner {
  $transaction<T>(
    operation: (tx: TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export interface SerializableTransactionOptions {
  provider?: DatabaseProvider;
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
  random?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: { attempt: number; delayMs: number; provider: DatabaseProvider; error: unknown }) => void;
}

const DEFAULT_ATTEMPTS = 3;

export function databaseProviderFromUrl(url?: string): DatabaseProvider {
  if (url !== undefined) return /^(?:postgres|postgresql):\/\//i.test(url) ? "postgresql" : "sqlite";
  return resolveDatabaseRuntime().provider;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function isRetryableTransactionError(error: unknown, provider: DatabaseProvider): boolean {
  const code = errorCode(error);
  // P2028 covers several transaction API failures and is never safe to retry wholesale.
  if (code === "P2028") return false;
  if (provider === "postgresql") return code === "P2034";
  if (code && /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_|$)/i.test(code)) return true;
  return error instanceof Error && /SQLITE_(?:BUSY|LOCKED)|database (?:table |schema )?is locked/i.test(error.message);
}

function retryDelayMs(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** retryIndex);
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.min(maxDelayMs, Math.max(0, Math.round(exponential + jitter)));
}

export async function runSerializableTransaction<T>(
  client: TransactionRunner,
  operation: (tx: TransactionClient) => Promise<T>,
  options: SerializableTransactionOptions = {},
): Promise<T> {
  const provider = options.provider ?? databaseProviderFromUrl();
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const jitterRatio = options.jitterRatio ?? 0.25;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("Transaction attempts must be a positive integer.");
  if (baseDelayMs < 0 || maxDelayMs < baseDelayMs) throw new RangeError("Transaction retry delay bounds are invalid.");
  if (jitterRatio < 0 || jitterRatio > 1) throw new RangeError("Transaction retry jitter must be between zero and one.");

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: options.maxWaitMs ?? 5_000,
        timeout: options.timeoutMs ?? 20_000,
      });
    } catch (error) {
      if (attempt === attempts || !isRetryableTransactionError(error, provider)) throw error;
      const delayMs = retryDelayMs(attempt - 1, baseDelayMs, maxDelayMs, jitterRatio, random);
      options.onRetry?.({ attempt, delayMs, provider, error });
      await sleep(delayMs);
    }
  }

  throw new Error("Serializable transaction retry loop exhausted unexpectedly.");
}
