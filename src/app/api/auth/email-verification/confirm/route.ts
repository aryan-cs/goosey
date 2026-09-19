import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { confirmEmailVerification, InvalidAccountTokenError } from "@/lib/auth-recovery";
import { getAuthenticatedUser } from "@/lib/auth";
import { authRouteError, InvalidRequestError, jsonError, noStore, readJsonObject } from "@/lib/http";
import { assertMutationOrigin, enforceRateLimit, identityRateLimitKey, requestRateLimitKey, sha256 } from "@/lib/security";

const schema = z.object({ token: z.string().min(1).max(256) }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "email-verification-confirm:ip"), 20, 15 * 60_000);
    const parsed = schema.safeParse(await readJsonObject(request));
    if (!parsed.success) throw new InvalidRequestError();
    await enforceRateLimit(identityRateLimitKey("email-verification-confirm:token", sha256(parsed.data.token)), 5, 15 * 60_000);
    const sessionUser = await getAuthenticatedUser(request);
    const result = await confirmEmailVerification(parsed.data.token);
    return noStore(NextResponse.json({
      verified: true,
      welcomeGrantIssued: result.welcomeGrantIssued,
      requiresSignIn: sessionUser?.id !== result.userId,
    }));
  } catch (error) {
    if (error instanceof InvalidAccountTokenError) {
      return jsonError(400, "INVALID_OR_EXPIRED_TOKEN", error.message);
    }
    return authRouteError(error);
  }
}
