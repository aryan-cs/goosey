import { address } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const u64 = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);

export const managedEscrowCommandEnvelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("DEPOSIT_ESCROW"),
  request: z.object({
    parentCommandId: z.string().min(8).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
      .refine(value => BigInt(value) <= (1n << 64n) - 1n),
    walletAddress: z.string().min(32).max(64),
    amount: u64,
    fundingPolicyVersion: z.literal("exact-order-reserve-v1"),
  }).strict(),
}).strict();

type CommandStore = Pick<PrismaChainCommandStore, "createOrReplay" | "publicStatus">;
type Database = TransactionRunner & Pick<typeof db, "market" | "solanaCustodyIdentity">;
type Dependencies = Readonly<{
  database?: Database;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  store?: CommandStore;
  provider?: DatabaseProvider;
}>;

/** Accepts an immutable child deposit for one previously accepted order. */
export async function acceptManagedEscrowDeposit(input: Readonly<{
  userId: string;
  marketSlug: string;
  parentCommandId: string;
  amount: bigint;
}>, dependencies: Dependencies = {}): Promise<Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,190}$/.test(input.parentCommandId)
    || typeof input.amount !== "bigint" || input.amount <= 0n || input.amount > (1n << 64n) - 1n) {
    throw new Error("Invalid managed escrow deposit intent");
  }
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
    || binding.programAddress !== runtime.programAddress
    || !/^(0|[1-9][0-9]{0,19})$/.test(binding.chainMarketId)
    || BigInt(binding.chainMarketId) > (1n << 64n) - 1n) {
    throw new ApiError(503, "MARKET_DEPLOYMENT_UNAVAILABLE", "Market settlement is temporarily unavailable.");
  }
  const identity = await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.userId, env, database);
  const walletAddress = address(identity.walletAddress).toString();
  const commandIdentity = acceptChainCommand({
    runtime,
    scope: "USER",
    scopeId: input.userId,
    actorId: input.userId,
    operation: "DEPOSIT_ESCROW",
    idempotencyKey: `managed-escrow:v1:${input.parentCommandId}`,
    request: {
      parentCommandId: input.parentCommandId,
      marketId: market.id,
      marketSlug: input.marketSlug,
      chainMarketId: binding.chainMarketId,
      walletAddress,
      amount: input.amount.toString(),
      fundingPolicyVersion: "exact-order-reserve-v1",
    },
  });
  const store = dependencies.store ?? new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(commandIdentity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}

