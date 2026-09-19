/** JSON-safe serialization for Prisma values. Monetary BigInts are strings on the wire. */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        jsonSafe(entry),
      ]),
    );
  }
  return value;
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(jsonSafe(value));
}

export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string | null | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    if (
      !Object.values(parsed as Record<string, unknown>).every(
        (entry) => typeof entry === "string",
      )
    ) {
      return undefined;
    }
    return parsed as Record<string, string>;
  } catch {
    return undefined;
  }
}

type CommentForSerialization = {
  id: string;
  userId: string;
  marketId: string;
  parentId: string | null;
  body: string;
  status: string;
  positionSideSnapshot: string | null;
  positionQtySnapshot: number | null;
  createdAt: Date;
  updatedAt: Date;
  user: { id: string; username: string; displayName: string };
  replies?: CommentForSerialization[];
};

export type SerializedComment = Omit<
  CommentForSerialization,
  "userId" | "marketId" | "user" | "replies"
> & {
  author: CommentForSerialization["user"];
  replies?: SerializedComment[];
};

export function serializeComment(comment: CommentForSerialization): SerializedComment {
  const { user, userId: _userId, marketId: _marketId, replies, ...publicComment } = comment;
  void _userId;
  void _marketId;
  return {
    ...publicComment,
    body: comment.status === "VISIBLE" ? comment.body : "[deleted]",
    author: user,
    ...(replies ? { replies: replies.map(serializeComment) } : {}),
  };
}
