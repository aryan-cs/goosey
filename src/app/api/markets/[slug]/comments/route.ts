import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonObject } from "@/lib/http";
import {
  ApiError,
  apiErrorResponse,
  consumeRateLimit,
  jsonResponse,
  parseIdempotencyKey,
  prisma,
  requireUser,
} from "@/lib/market-service";
import { decodeCursor, encodeCursor, jsonStringify, serializeComment } from "@/lib/serializers";
import { getAuthenticatedUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ slug: z.string().min(1).max(160) }).strict();
const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(500).optional(),
    sort: z.enum(["top", "newest"]).default("newest"),
  })
  .strict();
const bodyTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(800)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), {
    message: "Comment contains unsupported control characters.",
  });
const createSchema = z
  .object({
    body: bodyTextSchema,
    parentId: z.string().cuid().nullable().optional(),
    disclosePosition: z.boolean().default(false),
  })
  .strict();

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const { slug } = paramsSchema.parse(await context.params);
    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const cursor = decodeCursor(query.cursor);
    if (query.cursor && !cursor?.id) throw new ApiError(400, "INVALID_CURSOR", "Cursor is invalid.");
    const market = await prisma.market.findUnique({ where: { slug }, select: { id: true, status: true } });
    const viewer = market?.status === "DRAFT" ? await getAuthenticatedUser(request) : null;
    if (!market || (market.status === "DRAFT" && viewer?.role !== "ADMIN")) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    const rows = await prisma.comment.findMany({
      where: {
        marketId: market.id,
        parentId: null,
        status: { in: ["VISIBLE", "DELETED"] },
      },
      orderBy: query.sort === "top"
        ? [{ replies: { _count: "desc" } }, { createdAt: "desc" }, { id: "desc" }]
        : [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(cursor?.id ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      include: {
        user: { select: { id: true, username: true, displayName: true } },
        replies: {
          where: { status: { in: ["VISIBLE", "DELETED"] } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 25,
          include: { user: { select: { id: true, username: true, displayName: true } } },
        },
      },
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(serializeComment);
    return jsonResponse({
      items,
      nextCursor: hasMore ? encodeCursor({ id: items.at(-1)!.id }) : null,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const idempotencyKey = parseIdempotencyKey(request);
    const { slug } = paramsSchema.parse(await context.params);
    const body = createSchema.parse(await readJsonObject(request));
    const requestHash = createHash("sha256").update(jsonStringify({ slug, body })).digest("hex");
    await consumeRateLimit(prisma, `comment:${user.id}:minute`, 5, 60_000);
    await consumeRateLimit(prisma, `comment:${user.id}:day`, 50, 86_400_000);
    const payload = await prisma.$transaction(async (tx) => {
      const route = `/api/markets/${slug}/comments`;
      const previous = await tx.idempotencyRequest.findUnique({ where: { userId_route_key: { userId: user.id, route, key: idempotencyKey } } });
      if (previous) {
        if (previous.requestHash !== requestHash) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was used for a different comment.");
        if (previous.status === "COMPLETED" && previous.responseBody) return JSON.parse(previous.responseBody) as unknown;
        throw new ApiError(409, "REQUEST_IN_PROGRESS", "This comment request is already being processed.");
      }
      await tx.idempotencyRequest.create({ data: { userId: user.id, route, key: idempotencyKey, requestHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000) } });
      const market = await tx.market.findUnique({
        where: { slug },
        select: { id: true, status: true },
      });
      if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
      if (["DRAFT"].includes(market.status)) {
        throw new ApiError(403, "COMMENTS_UNAVAILABLE", "Comments are unavailable for this market.");
      }
      if (body.parentId) {
        const parent = await tx.comment.findUnique({
          where: { id: body.parentId },
          select: { marketId: true, parentId: true, status: true, userId: true },
        });
        if (!parent || parent.marketId !== market.id || parent.parentId || parent.status !== "VISIBLE") {
          throw new ApiError(422, "INVALID_PARENT", "Reply target is not available.");
        }
      }
      const position = body.disclosePosition
        ? await tx.position.findUnique({
            where: { userId_marketId: { userId: user.id, marketId: market.id } },
          })
        : null;
      const side =
        position && position.yesShares !== position.noShares
          ? position.yesShares > position.noShares
            ? "YES"
            : "NO"
          : null;
      const quantity =
        side === "YES" ? position!.yesShares : side === "NO" ? position!.noShares : null;
      const created = await tx.comment.create({
        data: {
          userId: user.id,
          marketId: market.id,
          parentId: body.parentId ?? null,
          body: body.body,
          positionSideSnapshot: side,
          positionQtySnapshot: quantity,
        },
        include: { user: { select: { id: true, username: true, displayName: true } } },
      });
      await tx.market.update({
        where: { id: market.id },
        data: { commentCount: { increment: 1 } },
      });
      if (body.parentId) {
        const parent = await tx.comment.findUniqueOrThrow({ where: { id: body.parentId }, select: { userId: true } });
        if (parent.userId !== user.id) {
          await tx.notification.create({
            data: {
              userId: parent.userId,
              type: "COMMENT_REPLY",
              title: `${user.displayName} replied to you`,
              body: body.body.slice(0, 180),
              href: `/markets/${slug}#discussion-heading`,
            },
          });
        }
      }
      const response = { comment: serializeComment(created) };
      await tx.idempotencyRequest.update({ where: { userId_route_key: { userId: user.id, route, key: idempotencyKey } }, data: { status: "COMPLETED", responseCode: 201, responseBody: jsonStringify(response) } });
      return response;
    });
    return jsonResponse(payload, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
