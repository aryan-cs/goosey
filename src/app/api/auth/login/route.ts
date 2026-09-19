import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { emailVerificationState, loginUser, setSessionCookie } from "@/lib/auth";
import { authRouteError, InvalidRequestError, jsonError, noStore, readJsonObject } from "@/lib/http";
import {
  assertMutationOrigin,
  canonicalizeEmail,
  enforceRateLimit,
  identityRateLimitKey,
  isValidPassword,
  requestRateLimitKey,
} from "@/lib/security";

const schema = z.object({ email: z.string(), password: z.string() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "login:ip"), 30, 15 * 60 * 1_000);

    const parsed = schema.safeParse(await readJsonObject(request));
    if (!parsed.success) throw new InvalidRequestError();
    const body = parsed.data;
    const email = canonicalizeEmail(body.email);
    if (!email || !isValidPassword(body.password)) throw new InvalidRequestError();
    await enforceRateLimit(identityRateLimitKey("login:email", email), 10, 15 * 60 * 1_000);

    const result = await loginUser({
      email,
      password: body.password,
      userAgent: request.headers.get("user-agent"),
    });
    if (!result) return jsonError(401, "INVALID_CREDENTIALS", "Invalid email or password.");

    const response = NextResponse.json({
      user: result.user,
      emailVerification: emailVerificationState(result.user),
    });
    setSessionCookie(response, result.session);
    return noStore(response);
  } catch (error) {
    return authRouteError(error);
  }
}
