import { getNotificationFilter } from "@/lib/notification-preferences";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const preferencesFilter = await getNotificationFilter(user.id);
    const { limit } = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where: { userId: user.id, ...preferencesFilter }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit }),
      prisma.notification.count({ where: { userId: user.id, ...preferencesFilter, readAt: null } }),
    ]);
    return jsonResponse({ items, unreadCount }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const preferencesFilter = await getNotificationFilter(user.id);
    const result = await prisma.notification.updateMany({ where: { userId: user.id, ...preferencesFilter, readAt: null }, data: { readAt: new Date() } });
    return jsonResponse({ markedRead: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
