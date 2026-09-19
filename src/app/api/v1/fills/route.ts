import { NextRequest, NextResponse } from "next/server";

import { listUserFills, parseListFillsQuery } from "@/lib/fill-service";
import { apiErrorResponse, jsonResponse, requireUser } from "@/lib/market-service";

export const dynamic = "force-dynamic";

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const query = parseListFillsQuery(request.nextUrl.searchParams);
    return privateNoStore(jsonResponse(await listUserFills({ userId: user.id, ...query })));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}
