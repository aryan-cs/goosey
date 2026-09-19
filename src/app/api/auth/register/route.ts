import { NextRequest, NextResponse } from "next/server";

import { emailVerificationState, registerUser, setSessionCookie, WELCOME_GRANT_MILLI } from "@/lib/auth";
import { authRouteError, InvalidRequestError, noStore, readJsonObject } from "@/lib/http";
import {
  assertMutationOrigin,
  canonicalizeEmail,
  canonicalizeUsername,
  enforceRateLimit,
  identityRateLimitKey,
  isValidPassword,
  normalizeDisplayName,
  requestRateLimitKey,
} from "@/lib/security";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "register:ip"), 5, 60 * 60 * 1_000);

    const body = await readJsonObject(request);
    const email = canonicalizeEmail(body.email);
    const username = canonicalizeUsername(body.username);
    const displayName = username ? normalizeDisplayName(body.displayName, username) : null;
    if (!email || !username || !displayName || !isValidPassword(body.password) || body.acceptedCodeOfConduct !== true) {
      throw new InvalidRequestError();
    }

    await enforceRateLimit(identityRateLimitKey("register:email", email), 2, 24 * 60 * 60 * 1_000);
    const result = await registerUser({
      email,
      username,
      displayName,
      password: body.password,
      userAgent: request.headers.get("user-agent"),
    });

    const response = NextResponse.json(
      {
        user: result.user,
        balanceMilli: "0",
        pendingWelcomeGrantMilli: WELCOME_GRANT_MILLI.toString(),
        emailVerification: emailVerificationState(result.user),
      },
      { status: 201 },
    );
    setSessionCookie(response, result.session);
    return noStore(response);
  } catch (error) {
    return authRouteError(error);
  }
}
