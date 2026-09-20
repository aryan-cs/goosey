import { createHash } from "node:crypto";

import { address } from "@solana/kit";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
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
  database?: TransactionRunner & Pick<typeof db,
    "market" | "user" | "solanaCustodyIdentity" | "marketResolutionProposal" | "chainCommand">;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  readEscrow?: typeof readGooseyEscrow;
  provider?: DatabaseProvider;
}>;

type ResolutionText = Readonly<{ outcome: "YES" | "NO" | "VOID"; reason: string; evidence: string }>;

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function requireManagedMarketById(
  marketId: string,
  database: NonNullable<Dependencies["database"]>,
) {
  const market = await database.market.findUnique({
    where: { id: marketId },
    select: {
      id: true,
      slug: true,
      createdById: true,
      executionBackend: true,
      collateralAccountId: true,
      solanaBinding: { select: { cluster: true, genesisHash: true, programAddress: true, chainMarketId: true } },
    },
  });
  if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
  if (market.executionBackend !== "SOLANA" || market.collateralAccountId !== null || !market.solanaBinding) {
    throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This market does not use managed settlement.");
  }
  return market;
}

async function requireActiveAdminActor(
  actorUserId: string,
  database: NonNullable<Dependencies["database"]>,
) {
  const actor = await database.user.findUnique({ where: { id: actorUserId }, select: { role: true, status: true } });
  if (!actor || actor.role !== "ADMIN" || actor.status !== "ACTIVE") {
    throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
  }
}

async function managedResolutionSnapshot(input: Readonly<{
  actorUserId: string;
  market: Awaited<ReturnType<typeof requireManagedMarketById>>;
}>, dependencies: Dependencies) {
  const database = dependencies.database ?? db;
  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const binding = input.market.solanaBinding!;
  if (binding.cluster !== runtime.cluster || binding.genesisHash !== runtime.genesisHash
    || binding.programAddress !== runtime.programAddress || !u64.safeParse(binding.chainMarketId).success) {
    throw new ApiError(503, "MARKET_DEPLOYMENT_UNAVAILABLE", "Market settlement is temporarily unavailable.");
  }
  const identity = await (dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity)(input.actorUserId, env, database);
  const snapshot = await (dependencies.readEscrow ?? readGooseyEscrow)(runtime, {
    marketId: BigInt(binding.chainMarketId),
    wallet: address(identity.walletAddress),
  }, {
    includeOrderBook: true,
    includeResolution: true,
    includeMarketTerms: true,
  });
  if (!snapshot.resolution || !snapshot.marketTerms || !snapshot.orderBook?.reservesReconciled
    || snapshot.marketState.marketId !== BigInt(binding.chainMarketId)
    || snapshot.wallet !== identity.walletAddress) {
    throw new ApiError(503, "CHAIN_SNAPSHOT_UNAVAILABLE", "A complete finalized resolution snapshot is unavailable.");
  }
  return { runtime, identity, snapshot };
}

async function replayedCommand(input: Readonly<{
  actorUserId: string;
  marketId: string;
  operation: "PROPOSE_RESOLUTION" | "APPROVE_RESOLUTION";
  idempotencyKey: string;
}>, dependencies: Dependencies): Promise<PublicChainCommandStatus | null> {
  const database = dependencies.database ?? db;
  const runtime = resolveSolanaRuntime(dependencies.env ?? process.env);
  const command = await database.chainCommand.findUnique({
    where: { genesisHash_programAddress_scope_scopeId_operation_idempotencyKey: {
      genesisHash: runtime.genesisHash,
      programAddress: runtime.programAddress,
      scope: "MARKET",
      scopeId: input.marketId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
    } },
    select: { id: true, actorId: true },
  });
  if (!command) return null;
  if (command.actorId !== input.actorUserId) {
    throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key belongs to another resolution request.");
  }
  return new PrismaChainCommandStore(database, { provider: dependencies.provider }).publicStatus(command.id);
}

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

/** Accepts the ordinary admin proposal metadata and its exact on-chain fingerprint. */
export async function acceptManagedResolutionProposal(input: Readonly<{
  actorUserId: string;
  marketId: string;
  idempotencyKey: string;
  resolution: ResolutionText;
}>, dependencies: Dependencies = {}) {
  const database = dependencies.database ?? db;
  await requireActiveAdminActor(input.actorUserId, database);
  const market = await requireManagedMarketById(input.marketId, database);
  if (market.createdById === input.actorUserId) {
    throw new ApiError(403, "CREATOR_CANNOT_PROPOSE", "A market creator cannot propose its resolution.");
  }
  const requestHash = createHash("sha256").update(JSON.stringify({
    marketId: market.id,
    ...input.resolution,
  })).digest("hex");
  let proposal = await database.marketResolutionProposal.findUnique({
    where: { proposerId_idempotencyKey: { proposerId: input.actorUserId, idempotencyKey: input.idempotencyKey } },
  });
  let replayed = true;
  if (proposal) {
    if (proposal.marketId !== market.id || proposal.requestHash !== requestHash
      || proposal.outcome !== input.resolution.outcome || proposal.reason !== input.resolution.reason
      || proposal.evidence !== input.resolution.evidence) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for another resolution proposal.");
    }
    const command = await replayedCommand({ actorUserId: input.actorUserId, marketId: market.id,
      operation: "PROPOSE_RESOLUTION", idempotencyKey: input.idempotencyKey }, dependencies);
    if (command) return Object.freeze({ accepted: true as const,
      pending: !["FINALIZED", "PROJECTED", "FAILED_TERMINAL"].includes(command.status), proposal, command, replayed: true });
  }
  const { identity, snapshot } = await managedResolutionSnapshot({ actorUserId: input.actorUserId, market }, dependencies);
  const resolution = snapshot.resolution!;
  if (resolution.phase !== 1 || resolution.activeProposalSequence !== null
    || identity.walletAddress !== resolution.proposer.wallet) {
    throw new ApiError(409, "MARKET_NOT_RESOLVABLE", "This administrator is not the designated proposer for the current resolution phase.");
  }
  if (!proposal) {
    const pending = await database.marketResolutionProposal.findFirst({ where: { marketId: market.id, status: "PENDING" } });
    if (pending) throw new ApiError(409, "PROPOSAL_PENDING", "This market already has a pending resolution proposal.");
    proposal = await database.marketResolutionProposal.create({ data: {
      marketId: market.id,
      proposerId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      pendingKey: market.id,
      ...input.resolution,
    } });
    replayed = false;
  }
  const accepted = await acceptManagedResolutionCommand({
    actorUserId: input.actorUserId,
    marketSlug: market.slug,
    idempotencyKey: input.idempotencyKey,
    intent: {
      operation: "PROPOSE_RESOLUTION",
      sequence: resolution.nextProposalSequence.toString(),
      outcome: input.resolution.outcome,
      reasonDigestSha256: digestText(input.resolution.reason),
      evidenceDigestSha256: digestText(input.resolution.evidence),
    },
  }, dependencies);
  return Object.freeze({ ...accepted, proposal, replayed });
}

/** Accepts the second administrator's exact approval of a retained proposal. */
export async function acceptManagedResolutionApproval(input: Readonly<{
  actorUserId: string;
  proposalId: string;
  idempotencyKey: string;
}>, dependencies: Dependencies = {}) {
  const database = dependencies.database ?? db;
  await requireActiveAdminActor(input.actorUserId, database);
  const proposal = await database.marketResolutionProposal.findUnique({
    where: { id: input.proposalId },
    include: { market: { include: { solanaBinding: true } } },
  });
  if (!proposal) throw new ApiError(404, "PROPOSAL_NOT_FOUND", "Resolution proposal not found.");
  if (proposal.market.executionBackend !== "SOLANA" || proposal.market.collateralAccountId !== null
    || !proposal.market.solanaBinding) {
    throw new ApiError(409, "MARKET_BACKEND_MISMATCH", "This proposal does not use managed settlement.");
  }
  if (proposal.status !== "PENDING") {
    throw new ApiError(409, "PROPOSAL_ALREADY_REVIEWED", "This proposal has already been reviewed.");
  }
  if (proposal.proposerId === input.actorUserId) {
    throw new ApiError(403, "SELF_APPROVAL_FORBIDDEN", "A proposer cannot approve their own proposal.");
  }
  if (proposal.market.createdById === input.actorUserId) {
    throw new ApiError(403, "CREATOR_CANNOT_RESOLVE", "A market creator cannot resolve their own market.");
  }
  const market = await requireManagedMarketById(proposal.marketId, database);
  const replayed = await replayedCommand({ actorUserId: input.actorUserId, marketId: market.id,
    operation: "APPROVE_RESOLUTION", idempotencyKey: input.idempotencyKey }, dependencies);
  if (replayed) return Object.freeze({ accepted: true as const,
    pending: !["FINALIZED", "PROJECTED", "FAILED_TERMINAL"].includes(replayed.status), proposal, command: replayed, replayed: true });
  const { identity, snapshot } = await managedResolutionSnapshot({ actorUserId: input.actorUserId, market }, dependencies);
  const resolution = snapshot.resolution!;
  if (resolution.phase !== 2 || resolution.activeProposalSequence === null
    || identity.walletAddress !== resolution.approver.wallet
    || identity.walletAddress === resolution.proposer.wallet) {
    throw new ApiError(409, "PROPOSAL_NOT_APPROVABLE", "This administrator is not the designated approver for the active proposal.");
  }
  const accepted = await acceptManagedResolutionCommand({
    actorUserId: input.actorUserId,
    marketSlug: market.slug,
    idempotencyKey: input.idempotencyKey,
    intent: {
      operation: "APPROVE_RESOLUTION",
      sequence: resolution.activeProposalSequence.toString(),
      outcome: proposal.outcome,
      reasonDigestSha256: digestText(proposal.reason),
      evidenceDigestSha256: digestText(proposal.evidence),
    },
  }, dependencies);
  return Object.freeze({ ...accepted, proposal, replayed: false });
}
