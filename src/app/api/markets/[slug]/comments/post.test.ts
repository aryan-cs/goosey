import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  tx: {
    market: { findUnique: vi.fn(), update: vi.fn() },
    comment: { findUnique: vi.fn(), create: vi.fn() },
    position: { findUnique: vi.fn() },
    notification: { create: vi.fn() },
    idempotencyRequest: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
  requireUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getAuthenticatedUser: vi.fn() }));
vi.mock("@/lib/http", () => ({ readJsonObject: (request: Request) => request.json() }));
vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  apiErrorResponse: (error: { status?: number; code?: string }) =>
    Response.json({ error: { code: error.code } }, { status: error.status ?? 400 }),
  consumeRateLimit: vi.fn(),
  parseIdempotencyKey: () => "reply-test-key",
  requireUser: mocks.requireUser,
  jsonResponse: (value: unknown, init?: ResponseInit) => Response.json(value, init),
  prisma: { $transaction: (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx) },
}));

import { POST } from "./route";

const ROOT_ID = "cm12345678901234567890123";
const REPLY_ID = "cm12345678901234567890124";
const CREATED_ID = "cm12345678901234567890125";
const visibleRoot = { marketId: "market-a", parentId: null, status: "VISIBLE", userId: "root-author" };
const visibleReply = { ...visibleRoot, parentId: ROOT_ID, userId: "reply-author" };

function post(parentId?: string, body = "My reply") {
  return POST(new NextRequest("http://localhost:8080/api/markets/goose-market/comments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, parentId }),
  }), { params: Promise.resolve({ slug: "goose-market" }) });
}

describe("POST comment threading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "writer", displayName: "Writer" });
    mocks.tx.market.findUnique.mockResolvedValue({ id: "market-a", status: "OPEN" });
    mocks.tx.comment.findUnique.mockResolvedValue(visibleRoot);
    mocks.tx.comment.create.mockImplementation(async ({ data }) => ({
      ...data, id: CREATED_ID, status: "VISIBLE",
      user: { id: "writer", username: "writer", displayName: "Writer" },
    }));
  });

  it("creates a direct reply and notifies the target author", async () => {
    const response = await post(ROOT_ID);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ comment: { parentId: ROOT_ID } });
    expect(mocks.tx.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "root-author" }) });
  });

  it("attaches a reply to a reply to the root and notifies the selected reply author", async () => {
    mocks.tx.comment.findUnique.mockResolvedValueOnce(visibleReply).mockResolvedValueOnce(visibleRoot);
    const response = await post(REPLY_ID);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ comment: { parentId: ROOT_ID } });
    expect(mocks.tx.comment.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ parentId: ROOT_ID }) }));
    expect(mocks.tx.notification.create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "reply-author", href: `/markets/goose-market?comment=${CREATED_ID}#discussion-heading` }) });
  });

  it("does not notify someone replying to their own comment", async () => {
    mocks.tx.comment.findUnique.mockResolvedValue({ ...visibleRoot, userId: "writer" });
    expect((await post(ROOT_ID)).status).toBe(201);
    expect(mocks.tx.notification.create).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...visibleRoot, marketId: "other-market" },
    { ...visibleRoot, status: "HIDDEN" },
    { ...visibleRoot, status: "DELETED" },
  ])("rejects unavailable reply targets: %j", async (target) => {
    mocks.tx.comment.findUnique.mockResolvedValue(target);
    const response = await post(REPLY_ID);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_PARENT" } });
    expect(mocks.tx.comment.create).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { ...visibleRoot, marketId: "other-market" },
    { ...visibleRoot, status: "HIDDEN" },
    { ...visibleRoot, status: "DELETED" },
    { ...visibleRoot, parentId: REPLY_ID },
  ])("rejects a reply whose root is unavailable or invalid: %j", async (root) => {
    mocks.tx.comment.findUnique.mockResolvedValueOnce(visibleReply).mockResolvedValueOnce(root);
    expect((await post(REPLY_ID)).status).toBe(422);
    expect(mocks.tx.comment.create).not.toHaveBeenCalled();
  });

  it("still accepts root comments without a parent or notification", async () => {
    const response = await post();
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ comment: { parentId: null } });
    expect(mocks.tx.comment.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.notification.create).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(801), "invalid\u0000text"])("rejects invalid reply bodies", async (body) => {
    expect((await post(ROOT_ID, body)).status).toBe(400);
    expect(mocks.tx.comment.create).not.toHaveBeenCalled();
  });
});
