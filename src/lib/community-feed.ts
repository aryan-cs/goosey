import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/market-service";

const PAGE_SIZE = 25;
const encodedCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);
const cursorPayloadSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().cuid(),
}).strict();

type CommunityFeedCursor = {
  createdAt: Date;
  id: string;
};

const communityFeedSelect = {
  id: true,
  body: true,
  parentId: true,
  createdAt: true,
  user: { select: { username: true, displayName: true } },
  market: { select: { slug: true, shortTitle: true } },
} satisfies Prisma.CommentSelect;

export type CommunityFeedItem = Prisma.CommentGetPayload<{
  select: typeof communityFeedSelect;
}>;

export type CommunityFeedPage = {
  items: CommunityFeedItem[];
  nextCursor: string | null;
};

function invalidCursor(): never {
  throw new ApiError(400, "INVALID_CURSOR", "The community feed cursor is invalid.");
}

function parseCursor(raw: string): CommunityFeedCursor {
  try {
    const encoded = encodedCursorSchema.parse(raw);
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    const payload = cursorPayloadSchema.parse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    return { createdAt: new Date(payload.createdAt), id: payload.id };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return invalidCursor();
  }
}

function encodeCursor(cursor: CommunityFeedCursor): string {
  const payload = cursorPayloadSchema.parse({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export async function getCommunityFeed(cursor?: string): Promise<CommunityFeedPage> {
  const boundary = cursor === undefined ? undefined : parseCursor(cursor);
  const rows = await db.comment.findMany({
    where: {
      status: "VISIBLE",
      user: { profilePublic: true },
      market: { status: { not: "DRAFT" } },
      AND: [
        {
          OR: [
            { parentId: null },
            { parent: { is: { status: "VISIBLE" } } },
          ],
        },
        ...(boundary
          ? [{
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lt: boundary.id } },
              ],
            }]
          : []),
      ],
    },
    select: communityFeedSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const items = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last
      ? encodeCursor({ createdAt: last.createdAt, id: last.id })
      : null,
  };
}
