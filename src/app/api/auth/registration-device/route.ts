import { NextRequest, NextResponse } from "next/server";

import { REGISTRATION_DEVICE_COOKIE_NAME, setRegistrationDeviceCookie } from "@/lib/auth";
import { noStore } from "@/lib/http";
import { createRegistrationDeviceToken, isValidRegistrationDeviceToken } from "@/lib/security";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const existing = request.cookies.get(REGISTRATION_DEVICE_COOKIE_NAME)?.value;
  const response = new NextResponse(null, { status: 204 });
  if (!isValidRegistrationDeviceToken(existing)) setRegistrationDeviceCookie(response, createRegistrationDeviceToken());
  return noStore(response);
}
