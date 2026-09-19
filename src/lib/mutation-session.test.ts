import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ session: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/market-service", () => ({
  ApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/auth", () => ({
  INTERACTIVE_ROLES: ["USER", "ADMIN"],
  SESSION_COOKIE_NAME: "goosey_session",
  requiresEmailVerification: (actor: { role: string; emailVerifiedAt: Date | null }) =>
    actor.role === "USER" && actor.emailVerifiedAt === null,
}));

import { assertMutationSession, runAuthenticatedMutation } from "./mutation-session";
import { sha256 } from "./security";

const tx = { session: { findFirst: mocks.session } };
const request = () => new NextRequest("http://localhost:8080/api/notifications", {
  headers: { cookie: "goosey_session=current-session" },
});

describe("mutation session boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((operation) => operation(tx));
    mocks.session.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: new Date() } });
  });

  it("validates and writes through the same serializable transaction", async () => {
    const operation = vi.fn().mockResolvedValue({ count: 3 });
    await expect(runAuthenticatedMutation(request(), "owner", operation)).resolves.toEqual({ count: 3 });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
    expect(mocks.session).toHaveBeenCalledWith({
      where: {
        tokenHash: sha256("current-session"), userId: "owner", expiresAt: { gt: expect.any(Date) },
        user: { status: "ACTIVE", role: { in: ["USER", "ADMIN"] } },
      },
      select: { user: { select: { role: true, emailVerifiedAt: true } } },
    });
    expect(operation).toHaveBeenCalledWith(tx, { role: "USER", emailVerifiedAt: expect.any(Date) });
    expect(mocks.session.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]!);
  });

  it("does not run a mutation after the session is revoked", async () => {
    mocks.session.mockResolvedValue(null);
    const operation = vi.fn();
    await expect(runAuthenticatedMutation(request(), "owner", operation)).rejects.toMatchObject({ status: 401 });
    expect(operation).not.toHaveBeenCalled();
  });

  it("does not run a mutation after verification is revoked", async () => {
    mocks.session.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: null } });
    const operation = vi.fn();
    await expect(runAuthenticatedMutation(request(), "owner", operation)).rejects.toMatchObject({ status: 403 });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects missing cookies without a database query", async () => {
    await expect(assertMutationSession(tx as never, new NextRequest("http://localhost:8080"), "owner"))
      .rejects.toMatchObject({ status: 401 });
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("propagates a failed write instead of returning success", async () => {
    const failure = new Error("write failed");
    await expect(runAuthenticatedMutation(request(), "owner", vi.fn().mockRejectedValue(failure))).rejects.toBe(failure);
  });
});
