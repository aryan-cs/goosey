import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  transaction: vi.fn(),
  findFirst: vi.fn(),
  readJsonObject: vi.fn(),
  findMany: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE_NAME: "goosey_session", INTERACTIVE_ROLES: ["USER", "ADMIN"],
  requiresEmailVerification: (actor: { role: string; emailVerifiedAt: Date | null }) =>
    actor.role === "USER" && actor.emailVerifiedAt === null,
}));

vi.mock("@/lib/http", () => ({ readJsonObject: mocks.readJsonObject }));

vi.mock("@/lib/security", () => ({
  sha256: (value: string) => `hash:${value}`,
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
  requireUser: mocks.requireUser,
  prisma: {
    $transaction: mocks.transaction,
    session: {
      findMany: mocks.findMany,
    },
  },
  jsonResponse: vi.fn((value: unknown, init?: ResponseInit) =>
    NextResponse.json(value, init),
  ),
  apiErrorResponse: vi.fn((error: unknown) => {
    const candidate = error as { status?: number; code?: string; message?: string };
    return NextResponse.json(
      { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message } },
      { status: candidate.status ?? 500 },
    );
  }),
}));

import { DELETE, GET } from "./route";

const USER_ID = "user-a";
const CURRENT_SESSION_ID = "cm12345678901234567890123";
const OTHER_SESSION_ID = "cm12345678901234567890124";
const CREATED_AT = new Date("2026-09-19T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-09-20T12:00:00.000Z");
const tx = { session: { findFirst: mocks.findFirst, deleteMany: mocks.deleteMany } };

function request(method: "GET" | "DELETE", withCookie = true): NextRequest {
  return new NextRequest("http://localhost:8080/api/auth/sessions", {
    method,
    ...(withCookie ? { headers: { cookie: "goosey_session=current-token" } } : {}),
  });
}

function expectPrivateNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("vary")).toContain("Cookie");
}

describe("/api/auth/sessions account workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: USER_ID, role: "USER", emailVerifiedAt: CREATED_AT });
    mocks.transaction.mockImplementation((operation) => operation(tx));
    mocks.findFirst.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: CREATED_AT } });
    mocks.readJsonObject.mockResolvedValue({ allOther: true });
    mocks.findMany.mockResolvedValue([]);
    mocks.deleteMany.mockResolvedValue({ count: 0 });
  });

  it("lists only the user's live sessions, strips token hashes, and marks the current session", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: CURRENT_SESSION_ID,
        tokenHash: "hash:current-token",
        userAgent: "Current browser",
        createdAt: CREATED_AT,
        expiresAt: EXPIRES_AT,
      },
      {
        id: OTHER_SESSION_ID,
        tokenHash: "hash:other-token",
        userAgent: "Other browser",
        createdAt: new Date(CREATED_AT.getTime() - 1_000),
        expiresAt: EXPIRES_AT,
      },
    ]);

    const incoming = request("GET");
    const response = await GET(incoming);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, expiresAt: { gt: expect.any(Date) } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        tokenHash: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
      },
    });
    expect(body.items).toEqual([
      expect.objectContaining({ id: CURRENT_SESSION_ID, current: true }),
      expect.objectContaining({ id: OTHER_SESSION_ID, current: false }),
    ]);
    expect(body.items[0]).not.toHaveProperty("tokenHash");
    expect(body.items[1]).not.toHaveProperty("tokenHash");
    expectPrivateNoStore(response);
  });

  it("revokes every other session within the authenticated user's scope", async () => {
    mocks.readJsonObject.mockResolvedValue({ allOther: true });
    mocks.deleteMany.mockResolvedValue({ count: 2 });
    const incoming = request("DELETE");

    const response = await DELETE(incoming);

    expect(response.status).toBe(200);
    expect(mocks.requireUser).toHaveBeenCalledWith(incoming, true);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: "hash:current-token", userId: USER_ID, expiresAt: { gt: expect.any(Date) },
        user: { status: "ACTIVE", role: { in: ["USER", "ADMIN"] } },
      },
      select: { user: { select: { role: true, emailVerifiedAt: true } } },
    });
    expect(mocks.findFirst.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteMany.mock.invocationCallOrder[0]!);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        tokenHash: { not: "hash:current-token" },
      },
    });
    await expect(response.json()).resolves.toEqual({ revoked: 2 });
    expectPrivateNoStore(response);
  });

  it("revokes one owned non-current session while preserving the current session", async () => {
    mocks.readJsonObject.mockResolvedValue({ sessionId: OTHER_SESSION_ID });
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    const response = await DELETE(request("DELETE"));

    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        id: OTHER_SESSION_ID,
        userId: USER_ID,
        tokenHash: { not: "hash:current-token" },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 1 });
  });

  it("returns SESSION_NOT_FOUND when the requested session is missing, foreign, or current", async () => {
    mocks.readJsonObject.mockResolvedValue({ sessionId: CURRENT_SESSION_ID });
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    const response = await DELETE(request("DELETE"));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        id: CURRENT_SESSION_ID,
        userId: USER_ID,
        tokenHash: { not: "hash:current-token" },
      },
    });
    expectPrivateNoStore(response);
  });

  it("applies private no-store headers to authentication errors", async () => {
    const error = Object.assign(new Error("Sign in to continue."), {
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    });
    mocks.requireUser.mockRejectedValue(error);

    const getResponse = await GET(request("GET", false));
    const deleteResponse = await DELETE(request("DELETE", false));

    expect(getResponse.status).toBe(401);
    expect(deleteResponse.status).toBe(401);
    expectPrivateNoStore(getResponse);
    expectPrivateNoStore(deleteResponse);
  });

  it.each([{ allOther: true }, { sessionId: OTHER_SESSION_ID }])("rejects revoked callers after body arrival before deleting sessions (%j)", async (body) => {
    mocks.readJsonObject.mockImplementationOnce(async () => {
      // Authentication succeeded, then the caller lost their session while
      // receiving/parsing the request body.
      mocks.findFirst.mockResolvedValue(null);
      return body;
    });
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expectPrivateNoStore(response);
  });

  it("preserves the verification gate for listing and revocation", async () => {
    mocks.requireUser.mockRejectedValue(Object.assign(new Error("Verify your email"), {
      status: 403, code: "EMAIL_VERIFICATION_REQUIRED",
    }));
    for (const response of [await GET(request("GET")), await DELETE(request("DELETE"))]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "EMAIL_VERIFICATION_REQUIRED" } });
      expectPrivateNoStore(response);
    }
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });

  it("rechecks verification inside the deletion transaction after body arrival", async () => {
    mocks.readJsonObject.mockImplementationOnce(async () => {
      mocks.findFirst.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: null } });
      return { allOther: true };
    });
    const response = await DELETE(request("DELETE"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "EMAIL_VERIFICATION_REQUIRED" } });
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.deleteMany).not.toHaveBeenCalled();
    expectPrivateNoStore(response);
  });

  it("rejects absent authentication without returning session data", async () => {
    mocks.requireUser.mockRejectedValue(Object.assign(new Error("Sign in"), {
      status: 401, code: "AUTHENTICATION_REQUIRED",
    }));
    for (const response of [await GET(request("GET")), await DELETE(request("DELETE"))]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "AUTHENTICATION_REQUIRED" } });
      expectPrivateNoStore(response);
    }
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
