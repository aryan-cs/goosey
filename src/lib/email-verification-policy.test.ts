import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { emailVerificationState, requiresEmailVerification } from "@/lib/auth";

const authMocks = vi.hoisted(() => ({ getAuthenticatedUser: vi.fn() }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getAuthenticatedUser: authMocks.getAuthenticatedUser };
});

import { ApiError, requireUser } from "@/lib/market-service";

const participant = {
  id: "user-1",
  email: "hacker@example.com",
  username: "hacker",
  displayName: "Hacker",
  role: "USER",
  status: "ACTIVE",
  emailVerifiedAt: null,
};

describe("email verification access policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires verification only for unverified participant accounts", () => {
    expect(requiresEmailVerification(participant)).toBe(true);
    expect(requiresEmailVerification({ role: "USER", emailVerifiedAt: new Date() })).toBe(false);
    expect(requiresEmailVerification({ role: "ADMIN", emailVerifiedAt: null })).toBe(false);
    expect(requiresEmailVerification({ role: "SYSTEM", emailVerifiedAt: null })).toBe(false);
    expect(emailVerificationState(participant)).toEqual({
      required: true,
      allowedActions: ["VERIFY_EMAIL", "RESEND_VERIFICATION", "LOGOUT"],
    });
  });

  it("rejects protected API access with a stable machine-readable contract", async () => {
    authMocks.getAuthenticatedUser.mockResolvedValue(participant);
    const request = new NextRequest("http://localhost:8080/api/portfolio");

    await expect(requireUser(request)).rejects.toMatchObject<Partial<ApiError>>({
      status: 403,
      code: "EMAIL_VERIFICATION_REQUIRED",
      details: {
        required: true,
        allowedActions: ["VERIFY_EMAIL", "RESEND_VERIFICATION", "LOGOUT"],
      },
    });
  });

  it.each(["ADMIN", "SYSTEM"])("keeps legacy %s operators compatible", async (role) => {
    authMocks.getAuthenticatedUser.mockResolvedValue({ ...participant, role });
    const request = new NextRequest("http://localhost:8080/api/admin/audit-logs");

    await expect(requireUser(request)).resolves.toMatchObject({ role });
  });
});
