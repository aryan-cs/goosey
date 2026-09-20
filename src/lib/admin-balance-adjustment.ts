import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireActiveAdmin } from "@/lib/admin-service";
import { ApiError, prisma } from "@/lib/market-service";
import { assertMutationSession } from "@/lib/mutation-session";
import { canonicalizeUsername } from "@/lib/security";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

const ISSUANCE_KEY = { ownerType: "SYSTEM", ownerId: "issuance", purpose: "ISSUANCE" } as const;

export const balanceDebitSchema = z.object({
  username: z.string().trim().min(3).max(24),
  amountMilli: z.string().regex(/^[1-9]\d{2,11}$/).transform((value) => BigInt(value)),
  reason: z.string().trim().min(8).max(500),
  principalTreatment: z.enum(["REVERSE_GRANT", "RECORD_LOSS"]),
}).strict();

export type BalanceDebit = z.infer<typeof balanceDebitSchema>;

function requestHash(input: BalanceDebit): string {
  return createHash("sha256").update(JSON.stringify({ username: canonicalizeUsername(input.username), amountMilli: input.amountMilli.toString(), reason: input.reason, principalTreatment: input.principalTreatment })).digest("hex");
}

function metadataHash(metadata: string): string | null {
  try { const value = JSON.parse(metadata) as { requestHash?: unknown }; return typeof value.requestHash === "string" ? value.requestHash : null; }
  catch { return null; }
}

export function contributedCapitalDelta(type: string, amountMilli: bigint, metadata: string): bigint {
  if ((type === "WELCOME_GRANT" || type === "ADMIN_GRANT") && amountMilli > 0n) return amountMilli;
  if (type !== "ADMIN_BALANCE_DEBIT") return 0n;
  try {
    const value = JSON.parse(metadata) as { principalDeltaMilli?: unknown };
    return typeof value.principalDeltaMilli === "string" && /^-?\d+$/.test(value.principalDeltaMilli) ? BigInt(value.principalDeltaMilli) : 0n;
  } catch { return 0n; }
}

export async function debitUserBalance(input: { actorUserId: string; idempotencyKey: string; debit: BalanceDebit; sessionRequest?: NextRequest }) {
  const username = canonicalizeUsername(input.debit.username);
  if (!username) throw new ApiError(400, "INVALID_USERNAME", "Enter a valid Goosey username.");
  const hash = requestHash(input.debit);
  const scope = `ADMIN_BALANCE_DEBIT:${input.actorUserId}`;
  return runSerializableTransaction(prisma, async (tx) => {
    if (input.sessionRequest) await assertMutationSession(tx, input.sessionRequest, input.actorUserId);
    await requireActiveAdmin(tx, input.actorUserId);
    const previous = await tx.journalEntry.findUnique({ where: { idempotencyScope_idempotencyKey: { idempotencyScope: scope, idempotencyKey: input.idempotencyKey } }, select: { id: true, referenceId: true, metadata: true } });
    if (previous) {
      if (metadataHash(previous.metadata) !== hash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different balance adjustment.");
      const user = await tx.user.findUniqueOrThrow({ where: { id: previous.referenceId }, select: { username: true, balanceMilli: true } });
      return { journalId: previous.id, username: user.username, balanceMilli: user.balanceMilli, replayed: true };
    }
    const user = await tx.user.findUnique({ where: { username }, select: { id: true, username: true, role: true, status: true, balanceMilli: true } });
    if (!user || user.role !== "USER" || user.status !== "ACTIVE") throw new ApiError(404, "USER_NOT_FOUND", "No active participant has that username.");
    const [wallet, issuance] = await Promise.all([
      tx.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" } } }),
      tx.ledgerAccount.findUnique({ where: { ownerType_ownerId_purpose: ISSUANCE_KEY } }),
    ]);
    if (!wallet || wallet.status !== "ACTIVE" || wallet.allowsNegative || wallet.balanceMilli !== user.balanceMilli) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "The participant wallet must be reconciled before it can be adjusted.");
    if (!issuance || issuance.status !== "ACTIVE" || !issuance.allowsNegative) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "The issuance account is unavailable.");
    const [walletPosted, issuancePosted] = await Promise.all([
      tx.ledgerPosting.aggregate({ where: { ledgerAccountId: wallet.id, journalEntry: { status: "POSTED" } }, _sum: { amountMilli: true } }),
      tx.ledgerPosting.aggregate({ where: { ledgerAccountId: issuance.id, journalEntry: { status: "POSTED" } }, _sum: { amountMilli: true } }),
    ]);
    if ((walletPosted._sum.amountMilli ?? 0n) !== wallet.balanceMilli || (issuancePosted._sum.amountMilli ?? 0n) !== issuance.balanceMilli) throw new ApiError(409, "ACCOUNT_RECONCILIATION_REQUIRED", "Ledger postings and account caches must reconcile before an adjustment.");
    if (wallet.balanceMilli < input.debit.amountMilli) throw new ApiError(409, "INSUFFICIENT_AVAILABLE_BALANCE", "The debit exceeds the participant's available balance.");
    const principalDeltaMilli = input.debit.principalTreatment === "REVERSE_GRANT" ? -input.debit.amountMilli : 0n;
    const journal = await tx.journalEntry.create({ data: {
      type: "ADMIN_BALANCE_DEBIT", status: "POSTED", referenceType: "USER", referenceId: user.id, idempotencyScope: scope, idempotencyKey: input.idempotencyKey, actorUserId: input.actorUserId,
      metadata: JSON.stringify({ requestHash: hash, username: user.username, amountMilli: input.debit.amountMilli.toString(), reason: input.debit.reason, principalTreatment: input.debit.principalTreatment, principalDeltaMilli: principalDeltaMilli.toString() }),
      postings: { create: [{ ledgerAccountId: wallet.id, amountMilli: -input.debit.amountMilli }, { ledgerAccountId: issuance.id, amountMilli: input.debit.amountMilli }] },
    }, select: { id: true } });
    const [walletUpdate, userUpdate, issuanceUpdate] = await Promise.all([
      tx.ledgerAccount.updateMany({ where: { id: wallet.id, status: "ACTIVE", balanceMilli: wallet.balanceMilli }, data: { balanceMilli: { decrement: input.debit.amountMilli } } }),
      tx.user.updateMany({ where: { id: user.id, status: "ACTIVE", balanceMilli: user.balanceMilli }, data: { balanceMilli: { decrement: input.debit.amountMilli } } }),
      tx.ledgerAccount.updateMany({ where: { id: issuance.id, status: "ACTIVE", balanceMilli: issuance.balanceMilli }, data: { balanceMilli: { increment: input.debit.amountMilli } } }),
    ]);
    if (walletUpdate.count !== 1 || userUpdate.count !== 1 || issuanceUpdate.count !== 1) throw new ApiError(409, "BALANCE_CHANGED", "A balance changed while the adjustment was being applied. Retry safely with the same idempotency key.");
    const balanceMilli = wallet.balanceMilli - input.debit.amountMilli;
    await tx.auditLog.create({ data: { actorUserId: input.actorUserId, action: "ADMIN_BALANCE_DEBITED", entityType: "USER", entityId: user.id, metadata: JSON.stringify({ journalId: journal.id, username: user.username, amountMilli: input.debit.amountMilli.toString(), balanceBeforeMilli: wallet.balanceMilli.toString(), balanceAfterMilli: balanceMilli.toString(), reason: input.debit.reason, principalTreatment: input.debit.principalTreatment }) } });
    return { journalId: journal.id, username: user.username, balanceMilli, replayed: false };
  });
}
