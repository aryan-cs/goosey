import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  confirmEmailVerification: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth-recovery", () => {
  class InvalidAccountTokenError extends Error {
    constructor() {
      super("The link is invalid or has expired.");
      this.name = "InvalidAccountTokenError";
    }
  }

  return {
    confirmEmailVerification: mocks.confirmEmailVerification,
    InvalidAccountTokenError,
  };
});

vi.mock("@/lib/auth", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser,
}));

vi.mock("@/lib/security", () => ({
  assertMutationOrigin: vi.fn(),
  enforceRateLimit: mocks.enforceRateLimit,
  identityRateLimitKey: vi.fn((scope: string, identity: string) => `${scope}:${identity}`),
  requestRateLimitKey: vi.fn((_request: Request, scope: string) => `${scope}:request`),
  sha256: vi.fn(() => "hashed-token"),
}));

import { InvalidAccountTokenError } from "@/lib/auth-recovery";
import { POST } from "./route";

const VERIFIED_USER_ID = "verified-user-123";

function request(token = "valid-verification-token"): NextRequest {
  return new NextRequest("http://localhost:8080/api/auth/email-verification/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:8080",
    },
    body: JSON.stringify({ token }),
  });
}

describe("POST /api/auth/email-verification/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(undefined);
    mocks.confirmEmailVerification.mockResolvedValue({
      userId: VERIFIED_USER_ID,
      welcomeGrantIssued: true,
    });
  });

  it("keeps the verified session in place when it belongs to the verified user", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: VERIFIED_USER_ID });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      verified: true,
      welcomeGrantIssued: true,
      requiresSignIn: false,
    });
    expect(body).not.toHaveProperty("userId");
  });

  it.each([
    ["there is no authenticated session", null],
    ["the authenticated session belongs to another user", { id: "different-user-456" }],
  ])("requires sign-in when %s", async (_label, authenticatedUser) => {
    mocks.getAuthenticatedUser.mockResolvedValue(authenticatedUser);
    mocks.confirmEmailVerification.mockResolvedValue({
      userId: VERIFIED_USER_ID,
      welcomeGrantIssued: false,
    });

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      verified: true,
      welcomeGrantIssued: false,
      requiresSignIn: true,
    });
    expect(body).not.toHaveProperty("userId");
  });

  it("preserves the invalid-token response without exposing identity data", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ id: VERIFIED_USER_ID });
    mocks.confirmEmailVerification.mockRejectedValue(new InvalidAccountTokenError());

    const response = await POST(request("expired-token"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "INVALID_OR_EXPIRED_TOKEN",
        message: "The link is invalid or has expired.",
      },
    });
    expect(body).not.toHaveProperty("userId");
    expect(JSON.stringify(body)).not.toContain(VERIFIED_USER_ID);
  });
});
