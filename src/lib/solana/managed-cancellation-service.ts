import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const U64_MAX = (1n << 64n) - 1n;
const referencePayloadSchema = z.object({
  marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  orderId: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(value => BigInt(value) <= U64_MAX),
}).strict();
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= U64_MAX);

export type ManagedCancellationReference = z.infer<typeof referencePayloadSchema>;
export type ManagedCancellationAcceptance = Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>;

/** Canonical public order identity used by the ordinary order API. The value is
 * only a lookup hint; finalized owner checks remain the authorization source. */
export function encodeManagedCancellationReference(value: ManagedCancellationReference): string {
  const parsed = referencePayloadSchema.parse(value);
  const reference = `g1.${parsed.marketSlug}.${parsed.orderId}`;
  if (reference.length > 200) throw new ApiError(400, "INVALID_ORDER_ID", "Order identifier is invalid.");
  return reference;
}

export function parseManagedCancellationReference(value: string): ManagedCancellationReference | null {
  if (!value.startsWith("g1.")) return null;
  try {
    if (value.length > 200) throw new Error();
    const match = /^g1\.([a-z0-9]+(?:-[a-z0-9]+)*)\.([1-9][0-9]{0,19})$/.exec(value);
    if (!match) throw new Error();
    const parsed = referencePayloadSchema.parse({ marketSlug: match[1], orderId: match[2] });
    if (encodeManagedCancellationReference(parsed) !== value) throw new Error();
    return parsed;
  } catch {
    throw new ApiError(400, "INVALID_ORDER_ID", "Order identifier is invalid.");
  }
}

type Dependencies = Readonly<{
  database?: TransactionRunner & Pick<typeof db, "market" | "solanaCustodyIdentity">;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  provider?: DatabaseProvider;
}>;

/** Accepts a cancellation intent without mutating SQL financial state. The
 * finalized dispatcher re-proves ownership and the exact resting order. */
export async function acceptManagedCancellation(input: Readonly<{
  userId: string;
  orderReference: ManagedCancellationReference;
  idempotencyKey: string;
  expectedVersion?: number;
}>, dependencies: Dependencies = {}): Promise<ManagedCancellationAcceptance> {
  const reference = referencePayloadSchema.parse(input.orderReference);
  if (input.expectedVersion !== undefined
    && (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)) {
    throw new ApiError(400, "INVALID_ORDER_VERSION", "Order version is invalid.");
  }
  const database = dependencies.database ?? db;
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const market = await database.market.findUnique({
    where: { slug: reference.marketSlug },
    select: {
      id: true,
      executionBackend: true,
      collateralAccountId: true,
      solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true, chainMarketId: true } },
    },
  });
  if (!market) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
  if (market.executionBackend !== "SOLANA" || market.collateralAccountId !== null || !market.solanaBinding) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
  }
  const binding = market.solanaBinding;
  if (binding.cluster !== runtime.cluster || binding.genesisHash !== runtime.genesisHash
    || binding.programAddress !== runtime.programAddress || !u64.safeParse(binding.chainMarketId).success) {
    throw new ApiError(503, "MARKET_DEPLOYMENT_UNAVAILABLE", "Market settlement is temporarily unavailable.");
  }

  await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.userId, env, database);
  const identity = acceptChainCommand({
    runtime,
    scope: "USER",
    scopeId: input.userId,
    actorId: input.userId,
    operation: "CANCEL_ORDER",
    idempotencyKey: input.idempotencyKey,
    request: {
      marketId: market.id,
      marketSlug: reference.marketSlug,
      chainMarketId: binding.chainMarketId,
      orderId: reference.orderId,
      ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
    },
  });
  const store = new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(identity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
