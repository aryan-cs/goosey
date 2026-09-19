import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";

import { INTERACTIVE_ROLES, SESSION_COOKIE_NAME, requiresEmailVerification } from "@/lib/auth";
import { ApiError, prisma } from "@/lib/market-service";
import { sha256 } from "@/lib/security";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

/** Revalidate after the request body has arrived, within the transaction that writes. */
export async function assertMutationSession(
  tx: Prisma.TransactionClient,
  request: NextRequest,
  expectedUserId: string,
): Promise<{ role: string; emailVerifiedAt: Date | null }> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  const session = await tx.session.findFirst({
    where: {
      tokenHash: sha256(token),
      userId: expectedUserId,
      expiresAt: { gt: new Date() },
      user: { status: "ACTIVE", role: { in: INTERACTIVE_ROLES } },
    },
    select: { user: { select: { role: true, emailVerifiedAt: true } } },
  });
  if (!session) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  if (requiresEmailVerification(session.user)) {
    throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your email before using Goosey.");
  }
  return session.user;
}

export async function runAuthenticatedMutation<T>(
  request: NextRequest,
  expectedUserId: string,
  operation: (tx: Prisma.TransactionClient, actor: { role: string; emailVerifiedAt: Date | null }) => Promise<T>,
): Promise<T> {
  return runSerializableTransaction(prisma, async (tx) => {
    const actor = await assertMutationSession(tx, request, expectedUserId);
    return operation(tx, actor);
  });
}
