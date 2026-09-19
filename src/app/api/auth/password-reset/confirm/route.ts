import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { confirmPasswordReset, InvalidAccountTokenError } from "@/lib/auth-recovery";
import { clearSessionCookie } from "@/lib/auth";
import { authRouteError, InvalidRequestError, jsonError, noStore, readJsonObject } from "@/lib/http";
import {
  assertMutationOrigin,
  enforceRateLimit,
  identityRateLimitKey,
  isValidPassword,
  requestRateLimitKey,
  sha256,
} from "@/lib/security";

const schema = z.object({ token: z.string().min(1).max(256), newPassword: z.string() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "password-reset-confirm:ip"), 20, 15 * 60_000);
    const parsed = schema.safeParse(await readJsonObject(request));
    if (!parsed.success || !isValidPassword(parsed.data.newPassword)) throw new InvalidRequestError();
    await enforceRateLimit(identityRateLimitKey("password-reset-confirm:token", sha256(parsed.data.token)), 5, 15 * 60_000);
    await confirmPasswordReset(parsed.data.token, parsed.data.newPassword);
    const response = NextResponse.json({ reset: true });
    clearSessionCookie(response);
    return noStore(response);
  } catch (error) {
    if (error instanceof InvalidAccountTokenError) {
      return jsonError(400, "INVALID_OR_EXPIRED_TOKEN", error.message);
    }
    return authRouteError(error);
  }
}
