import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "./chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "./chain-command-store";
import { ensureAppManagedSolanaIdentity } from "./custody-service";
import { type ManagedCancellationReference } from "./managed-cancellation-service";
import { resolveSolanaRuntime } from "./runtime";

const U64_MAX = (1n << 64n) - 1n;
const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= U64_MAX);
const referenceSchema = z.object({ marketSlug: z.string().min(1).max(160)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), orderId: z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine(value => BigInt(value) <= U64_MAX) }).strict();
const amendmentSchema = z.object({
  clientOrderId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  limitPriceMilli: z.string().regex(/^[1-9][0-9]{0,5}$/),
  quantity: z.number().int().min(1).max(10_000_000),
  postOnly: z.boolean(),
  selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]),
  expiresAt: z.string().datetime({ offset: true }).refine(value => new Date(value).getTime() % 1_000 === 0,
    "Managed replacement expiry must use whole UTC seconds").nullable().optional(),
  cancelOnPause: z.literal(true).optional(),
}).strict();

export type ManagedAmendmentAcceptance = Readonly<{ accepted: true; pending: true;
  command: PublicChainCommandStatus }>;
type Dependencies = Readonly<{
  database?: TransactionRunner & Pick<typeof db, "market" | "solanaCustodyIdentity">;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  provider?: DatabaseProvider;
}>;

/** Accepts an atomic cancel-and-replace intent. Managed callers must explicitly
 * supply admission-only options because resting on-chain state cannot recover
 * whether the original was post-only or which self-trade policy admitted it. */
export async function acceptManagedAmendment(input: Readonly<{
  userId: string;
  orderReference: ManagedCancellationReference;
  idempotencyKey: string;
  expectedVersion: number;
  request: unknown;
}>, dependencies: Dependencies = {}): Promise<ManagedAmendmentAcceptance> {
  const reference = referenceSchema.parse(input.orderReference);
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new ApiError(400, "INVALID_ORDER_VERSION", "Order version is invalid.");
  }
  const candidate = input.request as Record<string, unknown> | null;
  if (!candidate || candidate.postOnly === undefined || candidate.selfTradePrevention === undefined) {
    throw new ApiError(422, "MANAGED_REPLACEMENT_OPTIONS_REQUIRED",
      "Managed replacement requires explicit postOnly and selfTradePrevention values so the original order is never changed by assumption.");
  }
  if (candidate.cancelOnPause === false) {
    throw new ApiError(422, "MANAGED_REPLACEMENT_OPTION_UNSUPPORTED",
      "Managed orders must remain cancelable when the market pauses.");
  }
  const request = amendmentSchema.parse(candidate);
  const database = dependencies.database ?? db, env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const market = await database.market.findUnique({ where: { slug: reference.marketSlug }, select: {
    id: true, executionBackend: true, collateralAccountId: true,
    solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true, chainMarketId: true } },
  } });
  if (!market || market.executionBackend !== "SOLANA" || market.collateralAccountId !== null || !market.solanaBinding) {
    throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found.");
  }
  const binding = market.solanaBinding;
  if (binding.cluster !== runtime.cluster || binding.genesisHash !== runtime.genesisHash
    || binding.programAddress !== runtime.programAddress || !u64.safeParse(binding.chainMarketId).success) {
    throw new ApiError(503, "MARKET_DEPLOYMENT_UNAVAILABLE", "Market settlement is temporarily unavailable.");
  }
  await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.userId, env, database);
  const identity = acceptChainCommand({ runtime, scope: "USER", scopeId: input.userId, actorId: input.userId,
    operation: "REPLACE_ORDER", idempotencyKey: input.idempotencyKey, request: { marketId: market.id,
      marketSlug: reference.marketSlug, chainMarketId: binding.chainMarketId, orderId: reference.orderId,
      expectedVersion: input.expectedVersion, ...request } });
  const store = new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(identity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
