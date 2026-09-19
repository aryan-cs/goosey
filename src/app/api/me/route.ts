import { NextRequest, NextResponse } from "next/server";

import { emailVerificationState, getAuthenticatedUser, requiresEmailVerification } from "@/lib/auth";
import { db } from "@/lib/db";
import { authRouteError, jsonError, noStore } from "@/lib/http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) return jsonError(401, "UNAUTHENTICATED", "Authentication required.");
    if (requiresEmailVerification(user)) {
      return noStore(NextResponse.json({
        error: {
          code: "EMAIL_VERIFICATION_REQUIRED",
          message: "Verify your email before using Goosey.",
          details: emailVerificationState(user),
        },
      }, { status: 403 }));
    }

    const account = await db.ledgerAccount.findFirst({
      where: { ownerType: "USER", ownerId: user.id, purpose: "USER_FEATHERS" },
      select: { balanceMilli: true },
    });
    return noStore(NextResponse.json({
      user,
      balanceMilli: (account?.balanceMilli ?? 0n).toString(),
    }));
  } catch (error) {
    return authRouteError(error);
  }
}
