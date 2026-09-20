import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
  clearSessionCookie: vi.fn(),
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
    confirmPasswordReset: mocks.confirmPasswordReset,
    InvalidAccountTokenError,
  };
});

vi.mock("@/lib/auth", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
}));

vi.mock("@/lib/security", () => ({
  InvalidOriginError: class InvalidOriginError extends Error {},
  RegistrationDeviceInUseError: class RegistrationDeviceInUseError extends Error {},
  RateLimitError: class RateLimitError extends Error {
    readonly retryAfterSeconds = 1;
  },
  assertMutationOrigin: vi.fn(),
  enforceRateLimit: mocks.enforceRateLimit,
  identityRateLimitKey: vi.fn((scope: string, identity: string) => `${scope}:${identity}`),
  isValidPassword: vi.fn((value: unknown) => typeof value === "string" && value.length >= 12),
  requestRateLimitKey: vi.fn((_request: Request, scope: string) => `${scope}:request`),
  sha256: vi.fn(() => "hashed-token"),
}));

import { InvalidAccountTokenError } from "@/lib/auth-recovery";
import { POST } from "./route";

const VALID_TOKEN = "valid-password-reset-token";
const VALID_PASSWORD = "a replacement password phrase";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:8080/api/auth/password-reset/confirm", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:8080",
      cookie: "goosey_session=existing-session",
    },
    body: JSON.stringify(body),
  });
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("POST /api/auth/password-reset/confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(undefined);
    mocks.confirmPasswordReset.mockResolvedValue(undefined);
    mocks.clearSessionCookie.mockImplementation((response: NextResponse) => {
      response.cookies.set({
        name: "goosey_session",
        value: "",
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        expires: new Date(0),
        maxAge: 0,
      });
    });
  });

  it("resets the password, clears the current session cookie, and disables caching", async () => {
    const response = await POST(request({ token: VALID_TOKEN, newPassword: VALID_PASSWORD }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reset: true });
    expect(mocks.confirmPasswordReset).toHaveBeenCalledOnce();
    expect(mocks.confirmPasswordReset).toHaveBeenCalledWith(VALID_TOKEN, VALID_PASSWORD);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toContain("goosey_session=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("HttpOnly");
    expectNoStore(response);
  });

  it("returns the stable invalid-or-expired response without leaking token or service details", async () => {
    mocks.confirmPasswordReset.mockRejectedValue(new InvalidAccountTokenError());

    const response = await POST(request({ token: "expired-reset-token", newPassword: VALID_PASSWORD }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "INVALID_OR_EXPIRED_TOKEN",
        message: "The link is invalid or has expired.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("expired-reset-token");
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
    expectNoStore(response);
  });

  it("maps an unexpected service failure to a generic response and keeps the session cookie", async () => {
    mocks.confirmPasswordReset.mockRejectedValue(new Error("database=/private/reset.db password=secret"));

    const response = await POST(request({ token: VALID_TOKEN, newPassword: VALID_PASSWORD }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } });
    expect(JSON.stringify(body)).not.toContain("private/reset.db");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expectNoStore(response);
  });

  it.each([
    ["missing token", { newPassword: VALID_PASSWORD }],
    ["missing password", { token: VALID_TOKEN }],
    ["empty token", { token: "", newPassword: VALID_PASSWORD }],
    ["invalid password", { token: VALID_TOKEN, newPassword: "too short" }],
    ["unknown field", { token: VALID_TOKEN, newPassword: VALID_PASSWORD, userId: "another-user" }],
    ["array body", [{ token: VALID_TOKEN, newPassword: VALID_PASSWORD }]],
  ])("rejects a malformed body with %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.confirmPasswordReset).not.toHaveBeenCalled();
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
    expectNoStore(response);
  });
});
