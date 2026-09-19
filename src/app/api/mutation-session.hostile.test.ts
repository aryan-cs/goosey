import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  authenticated: undefined as undefined | (() => void),
  requireUser: vi.fn(), sessionFind: vi.fn(), write: vi.fn(), transaction: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  INTERACTIVE_ROLES: ["USER", "ADMIN"], SESSION_COOKIE_NAME: "goosey_session",
  requiresEmailVerification: (user: { role: string; emailVerifiedAt: Date | null }) => user.role === "USER" && user.emailVerifiedAt === null,
}));
vi.mock("@/lib/notification-preferences", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/notification-preferences")>(),
  getNotificationFilter: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  }
  const tx = {
    session: { findFirst: mocks.sessionFind },
    user: { update: mocks.write },
    comment: { updateMany: mocks.write, findUnique: mocks.write, create: mocks.write },
    commentReport: { create: mocks.write },
    market: { findFirst: mocks.write, findUnique: mocks.write },
    watchlistEntry: { upsert: mocks.write, deleteMany: mocks.write },
    marketSuggestion: { create: mocks.write },
    notification: { updateMany: mocks.write },
    idempotencyRequest: { findUnique: mocks.write },
  };
  return {
    ApiError, requireUser: mocks.requireUser, consumeRateLimit: vi.fn(), parseIdempotencyKey: () => "delayed-request-key",
    jsonResponse: (value: unknown, init?: ResponseInit) => Response.json(value, init),
    apiErrorResponse: (error: { status?: number; code?: string }) => Response.json({ error: { code: error.code } }, { status: error.status ?? 500 }),
    prisma: { $transaction: (callback: (tx: unknown) => unknown, options: unknown) => { mocks.transaction(options); return callback(tx); } },
  };
});

import { PATCH as profile } from "./profile/route";
import { PATCH as preferences } from "./settings/notifications/route";
import { POST as comment } from "./markets/[slug]/comments/route";
import { PATCH as editComment, DELETE as deleteComment } from "./comments/[id]/route";
import { POST as report } from "./comments/[id]/report/route";
import { POST as watchlist, DELETE as removeWatchlist } from "./watchlist/route";
import { POST as suggestion } from "./suggestions/route";
import { PATCH as notification } from "./notifications/[id]/route";
import { PATCH as notifications } from "./notifications/route";
import { assertMutationSession } from "@/lib/mutation-session";
import { sha256 } from "@/lib/security";

const RESOURCE = "cm12345678901234567890123";
const context = { params: Promise.resolve({ id: RESOURCE }) };
const routes = [
  { name: "profile", method: "PATCH", body: { bio: "Updated profile" }, call: (request: NextRequest) => profile(request) },
  { name: "notification preferences", method: "PATCH", body: { trades: true, resolutions: true, replies: true, suggestions: true }, call: (request: NextRequest) => preferences(request) },
  { name: "comment creation", method: "POST", body: { body: "Delayed comment" }, call: (request: NextRequest) => comment(request, { params: Promise.resolve({ slug: "test-market" }) }) },
  { name: "comment edit", method: "PATCH", body: { body: "Delayed edit" }, call: (request: NextRequest) => editComment(request, context) },
  { name: "report", method: "POST", body: { reason: "SPAM" }, call: (request: NextRequest) => report(request, context) },
  { name: "watchlist save", method: "POST", body: { marketId: RESOURCE }, call: (request: NextRequest) => watchlist(request) },
  { name: "watchlist removal", method: "DELETE", body: { marketId: RESOURCE }, call: (request: NextRequest) => removeWatchlist(request) },
  { name: "suggestion", method: "POST", body: { title: "Will this proposal be accepted?", description: "A delayed request should not create this suggestion after revocation.", category: "Campus" }, call: (request: NextRequest) => suggestion(request) },
];

describe("transaction-bound session authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockImplementation(async () => {
      mocks.authenticated?.();
      return { id: "owner", role: "USER", status: "ACTIVE", emailVerifiedAt: new Date(), displayName: "Owner" };
    });
    mocks.sessionFind.mockResolvedValue(null);
    mocks.write.mockResolvedValue({ bio: "Updated profile" });
  });

  it.each(routes)("rejects a revoked session after a delayed $name body arrives", async ({ method, body, call }) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const authenticated = new Promise<void>((resolve) => { mocks.authenticated = resolve; });
    const incoming = new NextRequest("http://localhost:8080/api/test", {
      method, headers: { "content-type": "application/json", cookie: "goosey_session=valid-before-revocation" }, body: stream, duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    const pending = call(incoming);
    await authenticated;
    // Initial authentication succeeded; the session is now revoked before the body completes.
    mocks.sessionFind.mockResolvedValue(null);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    controller.close();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.sessionFind).toHaveBeenCalledWith({
      where: { tokenHash: sha256("valid-before-revocation"), userId: "owner", expiresAt: { gt: expect.any(Date) }, user: { status: "ACTIVE", role: { in: ["USER", "ADMIN"] } } },
      select: { user: { select: { role: true, emailVerifiedAt: true } } },
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it.each([
    { name: "delete comment", call: (request: NextRequest) => deleteComment(request, context) },
    { name: "read notification", call: (request: NextRequest) => notification(request, context) },
    { name: "read all notifications", call: (request: NextRequest) => notifications(request) },
  ])("revalidates the session inside $name even without a body", async ({ call }) => {
    const response = await call(new NextRequest("http://localhost:8080/api/test", { method: "PATCH", headers: { cookie: "goosey_session=revoked" } }));
    expect(response.status).toBe(401);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("allows a verified active session and only mutates its authenticated owner", async () => {
    mocks.sessionFind.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: new Date() } });
    const response = await profile(new NextRequest("http://localhost:8080/api/profile", { method: "PATCH", headers: { "content-type": "application/json", cookie: "goosey_session=current" }, body: JSON.stringify({ bio: "Updated profile" }) }));
    expect(response.status).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "owner" }, data: { bio: "Updated profile" } }));
  });

  it("rejects verification revocation before any write", async () => {
    mocks.sessionFind.mockResolvedValue({ user: { role: "USER", emailVerifiedAt: null } });
    const response = await profile(new NextRequest("http://localhost:8080/api/profile", { method: "PATCH", headers: { "content-type": "application/json", cookie: "goosey_session=current" }, body: JSON.stringify({ bio: "Updated profile" }) }));
    expect(response.status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("requires the original session cookie rather than trusting the expected user ID", async () => {
    await expect(assertMutationSession({ session: { findFirst: mocks.sessionFind } } as never, new NextRequest("http://localhost:8080/api/test", { headers: { "x-user-id": "owner" } }), "owner")).rejects.toMatchObject({ status: 401 });
    expect(mocks.sessionFind).not.toHaveBeenCalled();
  });
});
