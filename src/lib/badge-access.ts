import type { Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import { requiresEmailVerification } from "@/lib/auth";
import { ApiError, prisma } from "@/lib/market-service";
import { sha256 } from "@/lib/security";

// Deliberately not accepted as a browser session or a recovery token.
export const BADGE_ACCESS_PURPOSE = "BADGE_DEVICE";
export const BADGE_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function badgeTokenHash(request: NextRequest): string {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new ApiError(401, "BADGE_LINK_REQUIRED", "Link this badge to your account.");
  return sha256(match[1]);
}

export async function requireBadgeAccess(
  tokenHash: string,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
  expectedUserId?: string,
) {
  const record = await tx.accountToken.findFirst({
    where: {
      tokenHash, purpose: BADGE_ACCESS_PURPOSE, consumedAt: null,
      expiresAt: { gt: new Date() },
      ...(expectedUserId ? { userId: expectedUserId } : {}),
      user: { status: "ACTIVE", role: "USER" },
    },
    select: { user: { select: { id: true, username: true, role: true, emailVerifiedAt: true } } },
  });
  if (!record) throw new ApiError(401, "BADGE_LINK_REQUIRED", "Link this badge to your account.");
  if (requiresEmailVerification(record.user)) throw new ApiError(403, "EMAIL_VERIFICATION_REQUIRED", "Verify your account on the website.");
  return record.user;
}
