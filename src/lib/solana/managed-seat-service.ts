import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);

export const managedSeatCommandEnvelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("REGISTER_SEAT"),
  request: z.object({
    seatInstructionVersion: z.literal(2),
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: u64,
    walletAddress: z.string().min(32).max(64),
  }).strict(),
}).strict();

export type ManagedSeatAcceptance = Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>;

type CommandStore = Pick<PrismaChainCommandStore, "createOrReplay" | "publicStatus">;
type Database = TransactionRunner & Pick<typeof db, "market" | "solanaCustodyIdentity">;
type Dependencies = Readonly<{
  database?: Database;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  store?: CommandStore;
  provider?: DatabaseProvider;
}>;

/**
 * Durably accepts one deterministic per-user/per-market seat intent. Replays
 * cannot change the market binding or the app-managed wallet address.
 */
export async function acceptManagedSeatRegistration(input: Readonly<{
  userId: string;
  marketSlug: string;
}>, dependencies: Dependencies = {}): Promise<ManagedSeatAcceptance> {
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

  const identity = await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.userId, env, database);
  const commandIdentity = acceptChainCommand({
    runtime,
    scope: "USER",
    scopeId: input.userId,
    actorId: input.userId,
    operation: "REGISTER_SEAT",
    idempotencyKey: `managed-seat:v2:${market.id}`,
    request: {
      seatInstructionVersion: 2,
      marketId: market.id,
      marketSlug: input.marketSlug,
      chainMarketId: binding.chainMarketId,
      walletAddress: identity.walletAddress,
    },
  });
  const store = dependencies.store ?? new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(commandIdentity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
