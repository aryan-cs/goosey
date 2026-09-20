import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import type { ManagedResolutionOperation } from "@/lib/solana/sponsored-resolution";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);
const sequence = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);
const digest = z.string().regex(/^[a-f0-9]{64}$/).refine(value => !/^0+$/.test(value));
const fingerprint = {
  sequence,
  outcome: z.enum(["YES", "NO", "VOID"]),
  reasonDigestSha256: digest,
  evidenceDigestSha256: digest,
} as const;

export const managedResolutionIntentSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("CLOSE_RESOLUTION") }).strict(),
  z.object({ operation: z.literal("PROPOSE_RESOLUTION"), ...fingerprint }).strict(),
  z.object({ operation: z.literal("APPROVE_RESOLUTION"), ...fingerprint }).strict(),
  z.object({ operation: z.literal("CLAIM_RESOLUTION") }).strict(),
  z.object({ operation: z.literal("FINALIZE_RESOLUTION") }).strict(),
]);

const commandRequestBase = {
  marketId: z.string().min(1).max(191),
  marketSlug: z.string().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  chainMarketId: u64,
} as const;

export const managedResolutionCommandEnvelopeSchema = z.discriminatedUnion("operation", [
  z.object({ version: z.literal(1), operation: z.literal("CLOSE_RESOLUTION"),
    request: z.object(commandRequestBase).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("PROPOSE_RESOLUTION"),
    request: z.object({ ...commandRequestBase, ...fingerprint }).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("APPROVE_RESOLUTION"),
    request: z.object({ ...commandRequestBase, ...fingerprint }).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("CLAIM_RESOLUTION"),
    request: z.object(commandRequestBase).strict() }).strict(),
  z.object({ version: z.literal(1), operation: z.literal("FINALIZE_RESOLUTION"),
    request: z.object(commandRequestBase).strict() }).strict(),
]);

export type ManagedResolutionIntent = z.infer<typeof managedResolutionIntentSchema>;
export type ManagedResolutionAcceptance = Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>;

type Dependencies = Readonly<{
  database?: TransactionRunner & Pick<typeof db, "market" | "user" | "solanaCustodyIdentity">;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  provider?: DatabaseProvider;
}>;

/** Accepts one immutable on-chain resolution step without projecting SQL settlement state. */
export async function acceptManagedResolutionCommand(input: Readonly<{
  actorUserId: string;
  marketSlug: string;
  idempotencyKey: string;
  intent: unknown;
}>, dependencies: Dependencies = {}): Promise<ManagedResolutionAcceptance> {
  const intent = managedResolutionIntentSchema.parse(input.intent);
  const database = dependencies.database ?? db;
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const market = await database.market.findUnique({
    where: { slug: input.marketSlug },
    select: {
      id: true,
      executionBackend: true,
      collateralAccountId: true,
      solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true, chainMarketId: true } },
    },
  });
  if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  if (market.executionBackend !== "SOLANA" || market.collateralAccountId !== null || !market.solanaBinding) {
    throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This market does not use managed settlement.");
  }
  const binding = market.solanaBinding;
  if (binding.cluster !== runtime.cluster || binding.genesisHash !== runtime.genesisHash
    || binding.programAddress !== runtime.programAddress || !u64.safeParse(binding.chainMarketId).success) {
    throw new ApiError(503, "MARKET_DEPLOYMENT_UNAVAILABLE", "Market settlement is temporarily unavailable.");
  }
  if (intent.operation !== "CLAIM_RESOLUTION") {
    const actor = await database.user.findUnique({
      where: { id: input.actorUserId },
      select: { role: true, status: true },
    });
    if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
      throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
    }
  }
  await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.actorUserId, env, database);

  const operation: ManagedResolutionOperation = intent.operation;
  const identity = acceptChainCommand({
    runtime,
    scope: operation === "CLAIM_RESOLUTION" ? "USER" : "MARKET",
    scopeId: operation === "CLAIM_RESOLUTION" ? input.actorUserId : market.id,
    actorId: input.actorUserId,
    operation,
    idempotencyKey: input.idempotencyKey,
    request: {
      marketId: market.id,
      marketSlug: input.marketSlug,
      chainMarketId: binding.chainMarketId,
      ...Object.fromEntries(Object.entries(intent).filter(([key]) => key !== "operation")),
    },
  });
  const store = new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(identity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
