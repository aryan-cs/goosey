import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  marketFindUnique: vi.fn(),
  commentFindFirst: vi.fn(),
  commentFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

vi.mock("@/lib/http", () => ({ readJsonObject: vi.fn() }));

vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  apiErrorResponse: vi.fn((error: unknown) => {
    const candidate = error as { status?: number; code?: string; message?: string };
    return Response.json(
      { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message } },
      { status: candidate.status ?? 500 },
    );
  }),
  consumeRateLimit: vi.fn(),
  jsonResponse: vi.fn((value: unknown, init?: ResponseInit) => Response.json(value, init)),
  parseIdempotencyKey: vi.fn(),
  requireUser: vi.fn(),
  prisma: {
    market: { findUnique: mocks.marketFindUnique },
    comment: { findFirst: mocks.commentFindFirst, findMany: mocks.commentFindMany },
  },
}));

import { GET } from "./route";
import { decodeCursor } from "@/lib/serializers";

const PARENT_ID = "cm12345678901234567890123";
const REPLY_ID = "cm12345678901234567890125";
const CREATED_AT = new Date("2026-09-19T12:00:00.000Z");
const user = { id: "user-a", username: "gosling", displayName: "Gosling" };

function comment(id: string, parentId: string | null, status = "VISIBLE") {
  return {
    id,
    userId: user.id,
    marketId: "market-a",
    parentId,
    body: `comment ${id}`,
    status,
    positionSideSnapshot: null,
    positionQtySnapshot: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    user,
  };
}

describe("GET /api/markets/[slug]/comments reply metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.marketFindUnique.mockResolvedValue({ id: "market-a", status: "OPEN" });
    mocks.commentFindFirst.mockResolvedValue(null);
  });

  it("returns 25 replies, an accurate visible count, and a scoped continuation cursor", async () => {
    const replies = Array.from({ length: 26 }, (_, index) =>
      comment(`cm12345678901234567890${String(index).padStart(3, "0")}`, PARENT_ID),
    );
    replies[1] = { ...replies[1], status: "DELETED", body: "removed text" };
    mocks.commentFindMany.mockResolvedValue([
      {
        ...comment(PARENT_ID, null),
        replies,
        _count: { replies: 31 },
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost:8080/api/markets/goose-market/comments"),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.commentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          replies: expect.objectContaining({
            where: { status: { in: ["VISIBLE", "DELETED"] } },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 26,
          }),
          _count: {
            select: {
              replies: { where: { status: { in: ["VISIBLE", "DELETED"] } } },
            },
          },
        }),
      }),
    );
    expect(body.items[0].replies).toHaveLength(25);
    expect(body.items[0].replies[1].body).toBe("[deleted]");
    expect(body.items[0].replyCount).toBe(31);
    expect(body.items[0]._count).toBeUndefined();
    expect(decodeCursor(body.items[0].repliesNextCursor)).toEqual({
      parentId: PARENT_ID,
      createdAt: CREATED_AT.toISOString(),
      id: replies[24].id,
    });
  });

  it("returns a null reply cursor when the initial page is complete", async () => {
    mocks.commentFindMany.mockResolvedValue([
      {
        ...comment(PARENT_ID, null),
        replies: [comment("cm12345678901234567890125", PARENT_ID)],
        _count: { replies: 1 },
      },
    ]);

    const response = await GET(
      new NextRequest("http://localhost:8080/api/markets/goose-market/comments"),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );
    const body = await response.json();

    expect(body.items[0]).toMatchObject({ replyCount: 1, repliesNextCursor: null });
  });
});

describe("GET /api/markets/[slug]/comments focused retrieval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.marketFindUnique.mockResolvedValue({ id: "market-a", status: "OPEN" });
    mocks.commentFindFirst.mockResolvedValue(null);
  });

  it("returns one focused root with its bounded initial reply page", async () => {
    const replies = Array.from({ length: 26 }, (_, index) =>
      comment(`cm12345678901234567891${String(index).padStart(3, "0")}`, PARENT_ID),
    );
    mocks.commentFindFirst
      .mockResolvedValueOnce({ id: PARENT_ID, parentId: null, createdAt: CREATED_AT })
      .mockResolvedValueOnce({
        ...comment(PARENT_ID, null),
        replies,
        _count: { replies: 31 },
      });

    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${PARENT_ID}`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      focusedCommentId: PARENT_ID,
      nextCursor: null,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(PARENT_ID);
    expect(body.items[0].replies).toHaveLength(25);
    expect(body.items[0].replyCount).toBe(31);
    expect(decodeCursor(body.items[0].repliesNextCursor)).toEqual({
      parentId: PARENT_ID,
      createdAt: CREATED_AT.toISOString(),
      id: replies[24].id,
    });
    expect(mocks.commentFindFirst).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: PARENT_ID,
          marketId: "market-a",
          status: { in: ["VISIBLE", "DELETED"] },
        },
      }),
    );
    expect(mocks.commentFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: PARENT_ID,
          marketId: "market-a",
          parentId: null,
          status: { in: ["VISIBLE", "DELETED"] },
        },
        include: expect.objectContaining({
          replies: expect.objectContaining({
            where: {
              marketId: "market-a",
              status: { in: ["VISIBLE", "DELETED"] },
            },
            take: 26,
          }),
        }),
      }),
    );
    expect(mocks.commentFindMany).not.toHaveBeenCalled();
  });

  it("starts a focused reply window at the requested reply, inclusively", async () => {
    const requestedAt = new Date("2026-09-19T13:00:00.000Z");
    const replies = [
      { ...comment(REPLY_ID, PARENT_ID), createdAt: requestedAt },
      ...Array.from({ length: 25 }, (_, index) => ({
        ...comment(`cm12345678901234567892${String(index).padStart(3, "0")}`, PARENT_ID),
        createdAt: new Date(requestedAt.getTime() + index + 1),
      })),
    ];
    mocks.commentFindFirst
      .mockResolvedValueOnce({ id: REPLY_ID, parentId: PARENT_ID, createdAt: requestedAt })
      .mockResolvedValueOnce({
        ...comment(PARENT_ID, null),
        replies,
        _count: { replies: 40 },
      });

    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${REPLY_ID}`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.focusedCommentId).toBe(REPLY_ID);
    expect(body.items[0].replies[0].id).toBe(REPLY_ID);
    expect(body.items[0].replies).toHaveLength(25);
    expect(mocks.commentFindFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: PARENT_ID, marketId: "market-a", parentId: null }),
        include: expect.objectContaining({
          replies: expect.objectContaining({
            where: {
              marketId: "market-a",
              status: { in: ["VISIBLE", "DELETED"] },
              OR: [
                { createdAt: { gt: requestedAt } },
                { createdAt: requestedAt, id: { gte: REPLY_ID } },
              ],
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 26,
          }),
        }),
      }),
    );
  });

  it("returns 404 for a hidden, missing, or cross-market focused comment", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${REPLY_ID}`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("COMMENT_NOT_FOUND");
    expect(mocks.commentFindFirst).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when a requested reply's root is unavailable", async () => {
    mocks.commentFindFirst
      .mockResolvedValueOnce({ id: REPLY_ID, parentId: PARENT_ID, createdAt: CREATED_AT })
      .mockResolvedValueOnce(null);

    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${REPLY_ID}`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "COMMENT_NOT_FOUND" } });
  });

  it("rejects combining focused retrieval with the normal list cursor", async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${REPLY_ID}&cursor=abc`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.marketFindUnique).not.toHaveBeenCalled();
    expect(mocks.commentFindFirst).not.toHaveBeenCalled();
  });

  it("keeps focused draft comments restricted to administrators", async () => {
    mocks.marketFindUnique.mockResolvedValue({ id: "market-a", status: "DRAFT" });
    mocks.getAuthenticatedUser.mockResolvedValue({ id: "user-a", role: "USER" });

    const response = await GET(
      new NextRequest(
        `http://localhost:8080/api/markets/goose-market/comments?comment=${PARENT_ID}`,
      ),
      { params: Promise.resolve({ slug: "goose-market" }) },
    );

    expect(response.status).toBe(404);
    expect(mocks.commentFindFirst).not.toHaveBeenCalled();
  });
});
