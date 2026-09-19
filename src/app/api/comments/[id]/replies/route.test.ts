import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

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
  prisma: {
    comment: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
    },
  },
  jsonResponse: vi.fn((value: unknown, init?: ResponseInit) => Response.json(value, init)),
  apiErrorResponse: vi.fn((error: unknown) => {
    const candidate = error as { status?: number; code?: string; message?: string };
    return Response.json(
      { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message } },
      { status: candidate.status ?? 500 },
    );
  }),
}));

import { GET } from "./route";
import { decodeCursor, encodeCommentReplyCursor } from "@/lib/serializers";

const PARENT_ID = "cm12345678901234567890123";
const OTHER_PARENT_ID = "cm12345678901234567890124";
const REPLY_1_ID = "cm12345678901234567890125";
const REPLY_2_ID = "cm12345678901234567890126";
const REPLY_3_ID = "cm12345678901234567890127";
const CREATED_AT = new Date("2026-09-19T12:00:00.000Z");
const user = { id: "user-a", username: "gosling", displayName: "Gosling" };

function request(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost:8080/api/comments/${PARENT_ID}/replies${query}`,
  );
}

function context(id = PARENT_ID): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function reply(id: string, status = "VISIBLE") {
  return {
    id,
    userId: user.id,
    marketId: "market-a",
    parentId: PARENT_ID,
    body: `reply ${id}`,
    status,
    positionSideSnapshot: null,
    positionQtySnapshot: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    user,
  };
}

describe("GET /api/comments/[id]/replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue({
      parentId: null,
      marketId: "market-a",
      status: "VISIBLE",
      market: { status: "OPEN" },
    });
    mocks.findMany.mockResolvedValue([]);
  });

  it("loads the first page without requiring a cursor", async () => {
    mocks.findMany.mockResolvedValue([reply(REPLY_1_ID)]);

    const response = await GET(request("?limit=25"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([REPLY_1_ID]);
    expect(body.nextCursor).toBeNull();
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          parentId: PARENT_ID,
          marketId: "market-a",
          status: { in: ["VISIBLE", "DELETED"] },
        },
        take: 26,
      }),
    );
  });

  it("uses ascending scoped keyset pagination and a bounded lookahead", async () => {
    const cursor = encodeCommentReplyCursor({
      parentId: PARENT_ID,
      createdAt: CREATED_AT,
      id: REPLY_1_ID,
    });
    mocks.findMany.mockResolvedValue([
      reply(REPLY_2_ID),
      reply(REPLY_3_ID, "DELETED"),
    ]);

    const response = await GET(
      request(`?limit=1&cursor=${encodeURIComponent(cursor)}`),
      context(),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        parentId: PARENT_ID,
        marketId: "market-a",
        status: { in: ["VISIBLE", "DELETED"] },
        OR: [
          { createdAt: { gt: CREATED_AT } },
          { createdAt: CREATED_AT, id: { gt: REPLY_1_ID } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      include: {
        user: { select: { id: true, username: true, displayName: true } },
      },
    });
    expect(body.items).toHaveLength(1);
    expect(decodeCursor(body.nextCursor)).toEqual({
      parentId: PARENT_ID,
      createdAt: CREATED_AT.toISOString(),
      id: REPLY_2_ID,
    });
  });

  it("rejects a cursor belonging to another parent before querying", async () => {
    const cursor = encodeCommentReplyCursor({
      parentId: OTHER_PARENT_ID,
      createdAt: CREATED_AT,
      id: REPLY_1_ID,
    });

    const response = await GET(
      request(`?cursor=${encodeURIComponent(cursor)}`),
      context(),
    );

    expect(response.status).toBe(400);
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("does not expose hidden, nested, or missing parents", async () => {
    mocks.findUnique.mockResolvedValue({
      parentId: null,
      marketId: "market-a",
      status: "HIDDEN",
      market: { status: "OPEN" },
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("requires an administrator to view replies in a draft market", async () => {
    mocks.findUnique.mockResolvedValue({
      parentId: null,
      marketId: "market-a",
      status: "VISIBLE",
      market: { status: "DRAFT" },
    });
    mocks.getAuthenticatedUser.mockResolvedValue({ role: "USER" });

    const denied = await GET(request(), context());
    expect(denied.status).toBe(404);
    expect(mocks.findMany).not.toHaveBeenCalled();

    mocks.getAuthenticatedUser.mockResolvedValue({ role: "ADMIN" });
    const allowed = await GET(request(), context());
    expect(allowed.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledOnce();
  });
});
