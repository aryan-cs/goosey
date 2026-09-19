import { NextRequest, NextResponse } from "next/server";
import { assertAdmin } from "@/lib/admin-service";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    const items = await prisma.marketSuggestion.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      take: 100,
      include: { user: { select: { username: true, displayName: true } } },
    });
    return jsonResponse({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
