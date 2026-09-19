import { NextRequest, NextResponse } from "next/server";

import { assertAdmin } from "@/lib/admin-service";
import { readAuditExportPage, serializeAuditCsv } from "@/lib/audit-export";
import { apiErrorResponse, consumeRateLimit, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
} as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    assertAdmin(user);
    await consumeRateLimit(prisma, `admin-audit-export:${user.id}`, 20, 60_000);
    const page = await readAuditExportPage(request.nextUrl.searchParams);

    if (page.format === "csv") {
      return new NextResponse(serializeAuditCsv(page.items), {
        status: 200,
        headers: {
          ...NO_STORE_HEADERS,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="goosey-audit-log.csv"',
          ...(page.nextCursor ? { "X-Next-Cursor": page.nextCursor } : {}),
        },
      });
    }

    return jsonResponse(
      { items: page.items, nextCursor: page.nextCursor, limit: page.limit },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) response.headers.set(name, value);
    return response;
  }
}
