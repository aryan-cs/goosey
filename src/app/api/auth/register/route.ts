import { NextRequest, NextResponse } from "next/server";

import { emailVerificationState, registerUser, RegistrationInviteError, setSessionCookie, WELCOME_GRANT_MILLI } from "@/lib/auth";
import { db } from "@/lib/db";
import { authRouteError, InvalidRequestError, jsonError, noStore, readJsonObject } from "@/lib/http";
import {
  assertMutationOrigin,
  canonicalizeEmail,
  canonicalizeUsername,
  enforceRateLimit,
  identityRateLimitKey,
  isValidPassword,
  normalizeDisplayName,
  constantTimeEqual,
  requestRateLimitKey,
  sha256,
} from "@/lib/security";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "register:ip"), 5, 60 * 60 * 1_000);

    const body = await readJsonObject(request);
    const submittedCode = typeof body.accessCode === "string" ? body.accessCode.trim() : "";
    const inviteCodeHash = submittedCode ? sha256(submittedCode) : null;
    const inviteExists = inviteCodeHash ? await db.registrationInvite.count({ where: { codeHash: inviteCodeHash } }) : 0;
    const developmentSharedCode = process.env.NODE_ENV !== "production" ? process.env.REGISTRATION_ACCESS_CODE : undefined;
    const validDevelopmentFallback = Boolean(developmentSharedCode && submittedCode && constantTimeEqual(submittedCode, developmentSharedCode));
    if (!inviteExists && !validDevelopmentFallback) return jsonError(403, "INVALID_ACCESS_CODE", "Enter a valid invite code that still has uses left.");
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
      inviteCodeHash: inviteExists ? inviteCodeHash : null,
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
    if (error instanceof RegistrationInviteError) return jsonError(403, "INVALID_ACCESS_CODE", error.message);
    return authRouteError(error);
  }
}
