import { NextRequest, NextResponse } from "next/server";

import { clearSessionCookie, revokeRequestSession } from "@/lib/auth";
import { authRouteError, noStore } from "@/lib/http";
import { assertMutationOrigin, enforceRateLimit, requestRateLimitKey } from "@/lib/security";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertMutationOrigin(request);
    await enforceRateLimit(requestRateLimitKey(request, "logout:ip"), 60, 15 * 60 * 1_000);
    await revokeRequestSession(request);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const browserForm = contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data";
    const response = browserForm || request.headers.get("accept")?.includes("text/html")
      ? NextResponse.redirect(new URL("/", request.url), 303)
      : NextResponse.json({ ok: true });
    clearSessionCookie(response);
    return noStore(response);
  } catch (error) {
    return authRouteError(error);
  }
}
