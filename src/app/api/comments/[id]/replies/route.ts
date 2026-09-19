import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getAuthenticatedUser } from "@/lib/auth";
import {
  ApiError,
  apiErrorResponse,
  jsonResponse,
  prisma,
} from "@/lib/market-service";
import {
  decodeCursor,
  encodeCommentReplyCursor,
  serializeComment,
} from "@/lib/serializers";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().cuid() }).strict();
const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    parentId: z.string().cuid(),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().cuid(),
  })
  .strict();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id: parentId } = paramsSchema.parse(await context.params);
    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (query.cursor) {
      const cursorResult = cursorSchema.safeParse(decodeCursor(query.cursor));
      if (!cursorResult.success || cursorResult.data.parentId !== parentId) {
        throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");
      }
      cursor = cursorResult.data;
    }

    const parent = await prisma.comment.findUnique({
      where: { id: parentId },
      select: {
        parentId: true,
        marketId: true,
        status: true,
        market: { select: { status: true } },
      },
    });
    if (
      !parent ||
      parent.parentId !== null ||
      !["VISIBLE", "DELETED"].includes(parent.status)
    ) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", "Comment not found.");
    }
    if (parent.market.status === "DRAFT") {
      const viewer = await getAuthenticatedUser(request);
      if (viewer?.role !== "ADMIN") {
        throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      }
    }

    const rows = await prisma.comment.findMany({
      where: {
        parentId,
        marketId: parent.marketId,
        status: { in: ["VISIBLE", "DELETED"] },
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  id: { gt: cursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      include: {
        user: { select: { id: true, username: true, displayName: true } },
      },
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    const lastReply = page.at(-1);

    return jsonResponse({
      items: page.map(serializeComment),
      nextCursor:
        hasMore && lastReply
          ? encodeCommentReplyCursor({
              parentId,
              createdAt: lastReply.createdAt,
              id: lastReply.id,
            })
          : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
