import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= (1n << 64n) - 1n);

export const managedOrderRequestSchema = z.object({
  clientOrderId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  outcome: z.enum(["YES", "NO"]),
  action: z.enum(["BUY", "SELL"]),
  limitPriceMilli: z.string().regex(/^[1-9]\d{0,17}$/),
  quantity: z.number().int().min(1).max(10_000_000),
  timeInForce: z.enum(["GTC", "IOC", "FOK"]),
  postOnly: z.boolean(),
  selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  cancelOnPause: z.literal(true),
  reduceOnly: z.literal(false),
}).strict();

export type ManagedOrderRequest = z.infer<typeof managedOrderRequestSchema>;
export type ManagedOrderAcceptance = Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>;

type Dependencies = Readonly<{
  database?: TransactionRunner & Pick<typeof db, "market" | "solanaCustodyIdentity">;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  provider?: DatabaseProvider;
}>;

/** Accepts one authenticated order intent into the durable command journal.
 * No SQL balance, position, fill, or price is written for Solana markets. */
export async function acceptManagedOrder(input: Readonly<{
  userId: string;
  marketSlug: string;
  idempotencyKey: string;
  request: unknown;
}>, dependencies: Dependencies = {}): Promise<ManagedOrderAcceptance> {
  const request = managedOrderRequestSchema.parse(input.request);
  const database = dependencies.database ?? db;
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const market = await database.market.findUnique({
    where: { slug: input.marketSlug },
    select: {
      id: true,
      executionBackend: true,
      status: true,
      collateralAccountId: true,
      solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true, chainMarketId: true } },
    },
  });
  if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  if (market.executionBackend !== "SOLANA" || market.collateralAccountId !== null || !market.solanaBinding) {
    throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This market does not use managed settlement.");
  }
  if (market.status !== "OPEN") throw new ApiError(409, "MARKET_NOT_OPEN", "This market is not open.");
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
    operation: "PLACE_ORDER",
    idempotencyKey: input.idempotencyKey,
    request: {
      marketId: market.id,
      marketSlug: input.marketSlug,
      chainMarketId: binding.chainMarketId,
      ...request,
    },
  });
  const store = new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(identity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
