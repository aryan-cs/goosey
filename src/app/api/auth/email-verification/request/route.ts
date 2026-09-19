import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requestEmailVerification } from "@/lib/auth-recovery";
import { authDestination } from "@/lib/auth-destination";
import { EmailDeliveryError } from "@/lib/email";
import { authRouteError, InvalidRequestError, jsonError, noStore, readJsonObject } from "@/lib/http";
import {
  assertMutationOrigin,
  canonicalizeEmail,
  enforceRateLimit,
  identityRateLimitKey,
  requestRateLimitKey,
} from "@/lib/security";

const schema = z.object({ email: z.string(), next: z.string().max(2048).optional() }).strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "email-verification-request:ip"), 5, 60 * 60_000);
    const parsed = schema.safeParse(await readJsonObject(request));
    const email = parsed.success ? canonicalizeEmail(parsed.data.email) : null;
    if (!parsed.success || !email) throw new InvalidRequestError();
    await enforceRateLimit(identityRateLimitKey("email-verification-request:email", email), 3, 60 * 60_000);
    await requestEmailVerification(email, authDestination(parsed.data.next));
    return noStore(NextResponse.json(
      { accepted: true, message: "If this account can be verified, an email will arrive shortly." },
      { status: 202 },
    ));
  } catch (error) {
    if (error instanceof EmailDeliveryError) {
      return jsonError(503, "EMAIL_UNAVAILABLE", "Email delivery is temporarily unavailable.");
    }
    return authRouteError(error);
  }
}
