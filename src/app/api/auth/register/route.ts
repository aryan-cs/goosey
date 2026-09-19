import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

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

const schema = z.object({
  email: z.string(),
  username: z.string(),
  displayName: z.string().nullable().optional(),
  password: z.string(),
  acceptedCodeOfConduct: z.literal(true),
}).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "register:ip"), 5, 60 * 60 * 1_000);

    const parsed = schema.safeParse(await readJsonObject(request));
    if (!parsed.success) throw new InvalidRequestError();
    const body = parsed.data;
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

    const verification = emailVerificationState(result.user);
    const response = NextResponse.json(
      {
        user: result.user,
        balanceMilli: verification.required ? "0" : WELCOME_GRANT_MILLI.toString(),
        pendingWelcomeGrantMilli: verification.required ? WELCOME_GRANT_MILLI.toString() : "0",
        emailVerification: verification,
      },
      { status: 201 },
    );
    setSessionCookie(response, result.session);
    return noStore(response);
  } catch (error) {
    return authRouteError(error);
  }
}
