vi.mock("@/lib/mutation-session", async () => {
  const { prisma } = await import("@/lib/market-service");
  return { runAuthenticatedMutation: async (_request: unknown, _userId: string, operation: (tx: unknown, actor: { role: string }) => Promise<unknown>) => {
    if ("$transaction" in prisma) return prisma.$transaction((tx) => operation(tx, { role: "USER" }));
    return operation(prisma, { role: "USER" });
  } };
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ update: vi.fn(), getAuthenticatedUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { user: { update: mocks.update } } }));
vi.mock("@/lib/auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
  requiresEmailVerification: (user: { emailVerifiedAt: string | null }) => !user.emailVerifiedAt,
  emailVerificationState: () => ({ required: true }),
}));

import { PATCH } from "./route";

const profile = { username: "  HACKER_01 ", bio: "  Building at HTN.  ", profilePublic: true };
function request(body: unknown, origin = "http://localhost:8080") {
  return new NextRequest("http://localhost:8080/api/profile", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthenticatedUser.mockResolvedValue({ id: "current-user", emailVerifiedAt: "2026-09-19T12:00:00Z" });
    mocks.update.mockImplementation(async ({ data }) => ({ ...data }));
  });

  it("normalizes username and keeps the public name in sync without a display-name field", async () => {
    const response = await PATCH(request(profile));
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "current-user" },
      data: { username: "hacker_01", displayName: "hacker_01", bio: "Building at HTN.", profilePublic: true },
    }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({ profile: { username: "hacker_01", displayName: "hacker_01" } });
  });

  it("preserves legacy display-name-only updates", async () => {
    const response = await PATCH(request({ displayName: "  Legacy Name  ", bio: "", profilePublic: false }));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ displayName: "Legacy Name", bio: "", profilePublic: false });
  });

  it("uses username as the public name when both names are supplied", async () => {
    const response = await PATCH(request({ ...profile, displayName: "Old Name" }));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data.displayName).toBe("hacker_01");
  });

  it("updates profile fields without overwriting privacy settings", async () => {
    const response = await PATCH(request({ username: profile.username, bio: profile.bio }));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ username: "hacker_01", displayName: "hacker_01", bio: "Building at HTN." });
  });

  it("updates privacy without overwriting profile fields", async () => {
    const response = await PATCH(request({ profilePublic: false }));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ profilePublic: false });
  });

  it.each([false, true])("rejects leaderboard visibility changes (%s)", async (leaderboardVisible) => {
    const response = await PATCH(request({ leaderboardVisible }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows clearing just the bio", async () => {
    const response = await PATCH(request({ bio: "  " }));
    expect(response.status).toBe(200);
    expect(mocks.update.mock.calls[0][0].data).toEqual({ bio: "" });
  });

  it.each(["ab", "with spaces", "_hacker", "hacker_", "a".repeat(25), "🪶hacker", ""])("rejects invalid username %s", async (username) => {
    const response = await PATCH(request({ ...profile, username }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...profile, bio: "a".repeat(281) },
    { ...profile, profilePublic: "true" },
    { leaderboardVisible: null },
    { ...profile, role: "ADMIN" },
    { ...profile, id: "victim-user" },
    { ...profile, userId: "victim-user" },
    { ...profile, balanceMilli: "999999999999999" },
    { ...profile, realizedPnlMilli: "999999999999999" },
    { ...profile, leaderboardRank: 1 },
    { ...profile, status: "ACTIVE" },
    { ...profile, emailVerifiedAt: "2026-09-19T12:00:00Z" },
    { ...profile, ledgerAccounts: { updateMany: { data: { balanceMilli: "999999999" } } } },
  ])("rejects invalid or unsupported profile fields", async (body) => {
    expect((await PATCH(request(body))).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("returns a clear conflict when the username is already taken", async () => {
    mocks.update.mockRejectedValue({ code: "P2002", meta: { target: ["username"] } });
    const response = await PATCH(request(profile));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "USERNAME_TAKEN", message: "That username is already taken. Choose another." } });
  });

  it("requires a signed-in user", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    expect((await PATCH(request(profile))).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires email verification", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: "current-user", emailVerifiedAt: null });
    const response = await PATCH(request(profile));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "EMAIL_VERIFICATION_REQUIRED" } });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects a foreign origin before reading the session", async () => {
    expect((await PATCH(request(profile, "https://untrusted.example"))).status).toBe(403);
    expect(mocks.getAuthenticatedUser).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
