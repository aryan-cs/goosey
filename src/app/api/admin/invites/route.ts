import { assertMutationSession } from "@/lib/mutation-session";
import { NextRequest, NextResponse } from "next/server";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { z } from "zod";
import { createHash } from "node:crypto";
import { assertAdmin, requireActiveAdmin } from "@/lib/admin-service";
import { readJsonObject } from "@/lib/http";
import { ApiError, apiErrorResponse, consumeRateLimit, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { deterministicSecretToken, sha256 } from "@/lib/security";

export const createInviteSchema = z.object({
  label: z.string().trim().min(2).max(80),
  maxUses: z.number().int().min(1).max(10).default(1),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict();

const inviteSelect = { id: true, label: true, status: true, maxUses: true, useCount: true, expiresAt: true, createdAt: true } as const;

function publicInvite(invite: { id: string; label: string; status: string; maxUses: number; useCount: number; expiresAt: Date | null; createdAt: Date }) {
  return { id: invite.id, label: invite.label, status: invite.status, maxUses: invite.maxUses, useCount: invite.useCount, expiresAt: invite.expiresAt, createdAt: invite.createdAt };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    const items = await prisma.registrationInvite.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: inviteSelect });
    return jsonResponse({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    assertAdmin(user);
    await consumeRateLimit(prisma, `admin-invite:${user.id}`, 30, 60_000);
    const body = createInviteSchema.parse(await readJsonObject(request));
    const idempotencyKey = parseIdempotencyKey(request);
    const issuanceKey = `${user.id}:${idempotencyKey}`;
    const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const code = deterministicSecretToken("registration-invite", issuanceKey);
    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        await assertMutationSession(tx, request, user.id);
        await requireActiveAdmin(tx, user.id);
        const previous = await tx.registrationInvite.findUnique({ where: { issuanceKey }, select: { ...inviteSelect, requestHash: true } });
        if (previous) {
          if (previous.requestHash !== requestHash) {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different invitation.");
          }
          return { invite: publicInvite(previous), replayed: true };
        }
        const invite = await tx.registrationInvite.create({
          data: {
            codeHash: sha256(code), issuanceKey, requestHash, label: body.label, maxUses: body.maxUses,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null, createdById: user.id,
          },
          select: inviteSelect,
        });
        await tx.auditLog.create({
          data: {
            actorUserId: user.id, action: "REGISTRATION_INVITE_CREATED", entityType: "REGISTRATION_INVITE", entityId: invite.id,
            metadata: JSON.stringify({ label: invite.label, maxUses: invite.maxUses, expiresAt: invite.expiresAt }),
          },
        });
        return { invite, replayed: false };
      });
    } catch (error) {
      if (!isPrismaErrorCode(error, "P2002")) throw error;
      const concurrent = await prisma.registrationInvite.findUnique({ where: { issuanceKey }, select: { ...inviteSelect, requestHash: true } });
      if (!concurrent) throw error;
      if (concurrent.requestHash !== requestHash) {
        throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different invitation.");
      }
      result = { invite: publicInvite(concurrent), replayed: true };
    }
    return jsonResponse({ ...result, code }, { status: result.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
