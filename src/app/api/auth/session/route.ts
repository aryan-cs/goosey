import { NextRequest, NextResponse } from "next/server";

import { emailVerificationState, getAuthenticatedUser } from "@/lib/auth";
import { authRouteError, noStore } from "@/lib/http";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    return noStore(NextResponse.json({
      authenticated: Boolean(user),
      user,
      emailVerification: user ? emailVerificationState(user) : null,
    }));
  } catch (error) {
    return authRouteError(error);
  }
}
