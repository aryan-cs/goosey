import { runAuthenticatedMutation } from "@/lib/mutation-session";
import { getNotificationFilter } from "@/lib/notification-preferences";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, apiErrorResponse, jsonResponse, prisma, requireUser } from "@/lib/market-service";
import {
  decodeNotificationCursor,
  encodeNotificationCursor,
  NotificationCursorError,
} from "@/lib/notification-pagination";
import { runSerializableTransaction } from "@/lib/serializable-transaction";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
}).strict();

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const { limit, cursor: encodedCursor } = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    for (const key of request.nextUrl.searchParams.keys()) {
      if (request.nextUrl.searchParams.getAll(key).length !== 1) {
        throw new ApiError(400, "INVALID_REQUEST", "Notification parameters cannot be repeated.");
      }
    }
    let cursor;
    try {
      cursor = encodedCursor ? decodeNotificationCursor(encodedCursor) : null;
    } catch (error) {
      if (error instanceof NotificationCursorError) {
        throw new ApiError(400, "INVALID_CURSOR", "The notification cursor is invalid.");
      }
      throw error;
    }
    const { rows, unreadCount, preferencesFilter } = await runSerializableTransaction(prisma, async (tx) => {
      const preferencesFilter = await getNotificationFilter(user.id, tx);
      const [rows, unreadCount] = await Promise.all([
        tx.notification.findMany({
          where: {
            userId: user.id, ...preferencesFilter,
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        }),
        tx.notification.count({ where: { userId: user.id, ...preferencesFilter, readAt: null } }),
      ]);
      return { rows, unreadCount, preferencesFilter };
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore ? items.at(-1) : null;
    const nextCursor = last ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }) : null;
    return jsonResponse({ items, unreadCount, nextCursor, visibilityKey: JSON.stringify(preferencesFilter) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const result = await runAuthenticatedMutation(request, user.id, async (tx) => {
      const preferencesFilter = await getNotificationFilter(user.id, tx);
      return tx.notification.updateMany({ where: { userId: user.id, ...preferencesFilter, readAt: null }, data: { readAt: new Date() } });
    });
    return jsonResponse({ markedRead: result.count }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiErrorResponse(error); }
}
