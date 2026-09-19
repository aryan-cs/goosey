vi.mock("@/lib/mutation-session", async () => {
  const { prisma } = await import("@/lib/market-service");
  return { runAuthenticatedMutation: async (_request: unknown, _userId: string, operation: (tx: unknown, actor: { role: string }) => Promise<unknown>) => {
    if ("$transaction" in prisma) return prisma.$transaction((tx) => operation(tx, { role: "USER" }));
    return operation(prisma, { role: "USER" });
  } };
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  principal: { id: "user-a" },
  requireUser: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    requireUser: mocks.requireUser,
    prisma: { notification: { updateMany: mocks.updateMany } },
    jsonResponse: vi.fn((value: unknown, init?: ResponseInit) => Response.json(value, init)),
    apiErrorResponse: vi.fn((error: unknown) => {
      const candidate = error as { status?: number; code?: string; message?: string };
      return Response.json(
        { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message ?? "error" } },
        { status: candidate.status ?? 500 },
      );
    }),
  };
});

import { PATCH } from "./route";

const NOTIFICATION_ID = "cm12345678901234567890123";
const context = { params: Promise.resolve({ id: NOTIFICATION_ID }) };

function request(): NextRequest {
  return new NextRequest(`http://localhost:8080/api/notifications/${NOTIFICATION_ID}`, { method: "PATCH" });
}

describe("PATCH /api/notifications/[id] ownership scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.principal = { id: "user-a" };
    mocks.requireUser.mockImplementation(async () => mocks.principal);
  });

  it("marks an owned notification using an ID-and-owner predicate", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    const incoming = request();

    const response = await PATCH(incoming, context);

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming, true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userId: "user-a" },
      data: { readAt: expect.any(Date) },
    });
    await expect(response.json()).resolves.toEqual({ read: true });
  });

  it("cannot mark another user's notification and returns indistinguishable not-found", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    const response = await PATCH(request(), context);

    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID, userId: "user-a" },
      data: { readAt: expect.any(Date) },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "NOTIFICATION_NOT_FOUND" },
    });
  });
});
