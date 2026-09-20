import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { acceptChainCommand, assertChainCommandReplay, type AcceptedChainCommandIdentity } from "@/lib/solana/chain-command";
import { GOOSEY_BOOK_BYTES, GOOSEY_BOOK_GROWTH } from "@/lib/solana/exchange-client";
import type { SolanaRuntime } from "@/lib/solana/runtime";

const u64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);
export const managedMarketBookStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }).strict(),
  z.object({ kind: z.literal("grow"), expectedSize: z.number().int().min(GOOSEY_BOOK_GROWTH)
    .max(GOOSEY_BOOK_BYTES - 1).refine(value => value % GOOSEY_BOOK_GROWTH === 0) }).strict(),
  z.object({ kind: z.literal("finalize") }).strict(),
]);
export type ManagedMarketBookStep = z.infer<typeof managedMarketBookStepSchema>;

export const managedMarketBookEnvelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("PROVISION_MARKET_BOOK"),
  request: z.object({
    provisioningVersion: z.literal(1),
    marketId: z.string().min(1).max(191),
    marketSlug: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    chainMarketId: u64,
    marketAddress: z.string().min(32).max(64),
    step: managedMarketBookStepSchema,
  }).strict(),
}).strict();

function stepKey(step: ManagedMarketBookStep): string {
  return step.kind === "grow" ? `grow:${step.expectedSize}` : step.kind;
}

export function nextManagedMarketBookStep(state: Readonly<{ ready: boolean; size: number }>): ManagedMarketBookStep | null {
  if (!Number.isSafeInteger(state.size) || state.size < 0 || state.size > GOOSEY_BOOK_BYTES) {
    throw new Error("Invalid observed order-book size");
  }
  if (state.ready) {
    if (state.size !== GOOSEY_BOOK_BYTES) throw new Error("Ready order book has the wrong size");
    return null;
  }
  if (state.size === 0) return Object.freeze({ kind: "create" });
  if (state.size === GOOSEY_BOOK_BYTES) return Object.freeze({ kind: "finalize" });
  if (state.size < GOOSEY_BOOK_GROWTH || state.size % GOOSEY_BOOK_GROWTH !== 0) {
    throw new Error("Draft order book has a noncanonical size");
  }
  return Object.freeze({ kind: "grow", expectedSize: state.size });
}

export function marketBookProvisioningIdentity(input: Readonly<{
  runtime: SolanaRuntime;
  actorUserId: string;
  marketId: string;
  marketSlug: string;
  chainMarketId: string;
  marketAddress: string;
  step: ManagedMarketBookStep;
}>): AcceptedChainCommandIdentity {
  const step = managedMarketBookStepSchema.parse(input.step);
  return acceptChainCommand({
    runtime: input.runtime,
    scope: "MARKET",
    scopeId: input.marketId,
    actorId: input.actorUserId,
    operation: "PROVISION_MARKET_BOOK",
    idempotencyKey: `managed-market-book:v1:${stepKey(step)}`,
    request: {
      provisioningVersion: 1,
      marketId: input.marketId,
      marketSlug: input.marketSlug,
      chainMarketId: u64.parse(input.chainMarketId),
      marketAddress: input.marketAddress,
      step,
    },
  });
}

/** Creates or verifies exactly one next book-step command inside the caller's
 * projection transaction, so a finalized parent cannot become stranded. */
export async function ensureManagedMarketBookCommand(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof marketBookProvisioningIdentity>[0],
) {
  const identity = marketBookProvisioningIdentity(input);
  const where = { genesisHash_programAddress_scope_scopeId_operation_idempotencyKey: {
    genesisHash: identity.genesisHash,
    programAddress: identity.programAddress,
    scope: identity.scope,
    scopeId: identity.scopeId,
    operation: identity.operation,
    idempotencyKey: identity.idempotencyKey,
  } } as const;
  const prior = await tx.chainCommand.findUnique({ where });
  if (prior) {
    assertChainCommandReplay({
      cluster: prior.cluster as "localnet" | "devnet",
      genesisHash: prior.genesisHash,
      programAddress: prior.programAddress,
      scope: prior.scope as "MARKET",
      scopeId: prior.scopeId,
      actorId: prior.actorId,
      operation: prior.operation,
      idempotencyKey: prior.idempotencyKey,
      requestHash: prior.requestHash,
      requestJson: prior.requestJson,
    }, identity);
    return prior;
  }
  return tx.chainCommand.create({ data: identity });
}
