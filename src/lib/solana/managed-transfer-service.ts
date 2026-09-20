import { address } from "@solana/kit";
import { z } from "zod";

import { INTERACTIVE_ROLES } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";
import { type DatabaseProvider, type TransactionRunner } from "@/lib/serializable-transaction";
import { acceptChainCommand } from "@/lib/solana/chain-command";
import { PrismaChainCommandStore, type PublicChainCommandStatus } from "@/lib/solana/chain-command-store";
import { ensureAppManagedSolanaIdentity } from "@/lib/solana/custody-service";
import { parseFeatherAmount } from "@/lib/solana/feather-transfer";
import { resolveSolanaRuntime } from "@/lib/solana/runtime";

const identifier = z.string().min(1).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const u64 = z.string().regex(/^[1-9][0-9]{0,19}$/)
  .refine(value => BigInt(value) <= (1n << 64n) - 1n);

export const managedTransferRequestSchema = z.object({
  recipientUserId: identifier,
  amount: z.string().min(1).max(32),
}).strict();

export const managedTransferCommandEnvelopeSchema = z.object({
  version: z.literal(1),
  operation: z.literal("TRANSFER_FEATHERS"),
  request: z.object({
    recipientUserId: identifier,
    senderWalletAddress: z.string().min(32).max(64),
    recipientWalletAddress: z.string().min(32).max(64),
    sponsorAddress: z.string().min(32).max(64),
    amount: u64,
    transferPolicyVersion: z.literal("managed-sponsored-spl-v1"),
  }).strict(),
}).strict();

type Database = TransactionRunner & Pick<typeof db, "user" | "solanaCustodyIdentity">;
type Dependencies = Readonly<{
  database?: Database;
  env?: Record<string, string | undefined>;
  ensureIdentity?: typeof ensureAppManagedSolanaIdentity;
  provider?: DatabaseProvider;
}>;

export type ManagedTransferAcceptance = Readonly<{
  accepted: true;
  pending: true;
  command: PublicChainCommandStatus;
}>;

/** Accepts one immutable, user-scoped app-custodied feather transfer. */
export async function acceptManagedFeatherTransfer(input: Readonly<{
  senderUserId: string;
  idempotencyKey: string;
  request: unknown;
}>, dependencies: Dependencies = {}): Promise<ManagedTransferAcceptance> {
  const request = managedTransferRequestSchema.parse(input.request);
  const amount = parseFeatherAmount(request.amount);
  if (request.recipientUserId === input.senderUserId) {
    throw new ApiError(409, "TRANSFER_SELF_RECIPIENT", "Choose another Goosey user.");
  }
  const database = dependencies.database ?? db;
  const recipient = await database.user.findFirst({
    where: {
      id: request.recipientUserId,
      status: "ACTIVE",
      role: { in: [...INTERACTIVE_ROLES] },
    },
    select: { id: true },
  });
  if (!recipient) throw new ApiError(404, "TRANSFER_RECIPIENT_NOT_FOUND", "Recipient not found.");

  const env = dependencies.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const sponsorAddress = address(env.GOOSEY_SOLANA_SPONSOR_ADDRESS ?? "").toString();
  const ensureIdentity = dependencies.ensureIdentity ?? ensureAppManagedSolanaIdentity;
  const senderIdentity = await ensureIdentity(input.senderUserId, env, database);
  const recipientIdentity = await ensureIdentity(recipient.id, env, database);
  const senderWalletAddress = address(senderIdentity.walletAddress).toString();
  const recipientWalletAddress = address(recipientIdentity.walletAddress).toString();
  if (senderWalletAddress === recipientWalletAddress || senderWalletAddress === sponsorAddress
    || recipientWalletAddress === sponsorAddress) {
    throw new Error("Managed transfer custody identities must be distinct");
  }

  const identity = acceptChainCommand({
    runtime,
    scope: "USER",
    scopeId: input.senderUserId,
    actorId: input.senderUserId,
    operation: "TRANSFER_FEATHERS",
    idempotencyKey: input.idempotencyKey,
    request: {
      recipientUserId: recipient.id,
      senderWalletAddress,
      recipientWalletAddress,
      sponsorAddress,
      amount: amount.toString(),
      transferPolicyVersion: "managed-sponsored-spl-v1",
    },
  });
  const store = new PrismaChainCommandStore(database, { provider: dependencies.provider });
  const command = await store.createOrReplay(identity);
  return Object.freeze({ accepted: true, pending: true, command: await store.publicStatus(command.state.id) });
}
