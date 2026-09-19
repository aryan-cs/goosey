import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  registerUser: vi.fn(),
  setSessionCookie: vi.fn(),
  setRegistrationDeviceCookie: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({
  registerUser: mocks.registerUser,
  setSessionCookie: mocks.setSessionCookie,
  setRegistrationDeviceCookie: mocks.setRegistrationDeviceCookie,
  REGISTRATION_DEVICE_COOKIE_NAME: "goosey_registration_device",
  WELCOME_GRANT_MILLI: 1_000_000n,
  emailVerificationState: () => ({ required: false }),
}));
vi.mock("@/lib/security", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security")>(),
  enforceRateLimit: mocks.enforceRateLimit,
}));

import { POST } from "./route";
import { createRegistrationDeviceToken, RegistrationDeviceInUseError } from "@/lib/security";

const signup = {
  email: "  HACKER@Example.COM ",
  username: "  Hacker_01 ",
  displayName: "Hack North",
  password: "CorrectHorseBattery42!",
  acceptedCodeOfConduct: true,
};
const deviceToken = createRegistrationDeviceToken();

function request(body: unknown, origin = "http://localhost:8080") {
  return new NextRequest("http://localhost:8080/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "user-agent": "registration-test", cookie: `goosey_registration_device=${deviceToken}` },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/register without invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(undefined);
    mocks.registerUser.mockResolvedValue({
      user: { id: "new-user", email: "hacker@example.com", username: "hacker_01", emailVerifiedAt: null },
      session: { token: "test-session" },
    });
  });

  it("registers without an access code and grants feathers immediately and keeps rate limits", async () => {
    const response = await POST(request(signup));

    expect(response.status).toBe(201);
    expect(mocks.registerUser).toHaveBeenCalledWith({
      email: "hacker@example.com",
      username: "hacker_01",
      displayName: "Hack North",
      password: signup.password,
      registrationDeviceToken: deviceToken,
      userAgent: "registration-test",
    });
    expect(mocks.enforceRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(response, { token: "test-session" });
    expect(mocks.setRegistrationDeviceCookie).toHaveBeenCalledWith(response, deviceToken);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      balanceMilli: "1000000",
      pendingWelcomeGrantMilli: "0",
      emailVerification: { required: false },
    });
  });

  it("uses the normalized username when signup omits a display name", async () => {
    const usernameOnlySignup = {
      email: signup.email,
      username: signup.username,
      password: signup.password,
      acceptedCodeOfConduct: signup.acceptedCodeOfConduct,
    };
    const response = await POST(request(usernameOnlySignup));

    expect(response.status).toBe(201);
    expect(mocks.registerUser).toHaveBeenCalledWith({
      email: "hacker@example.com",
      username: "hacker_01",
      displayName: "hacker_01",
      password: signup.password,
      registrationDeviceToken: deviceToken,
      userAgent: "registration-test",
    });
  });

  it.each([
    ["invalid email", { email: "not-an-email" }],
    ["invalid username", { username: "a" }],
    ["invalid display name", { displayName: 42 }],
    ["short password", { password: "short" }],
    ["declined terms", { acceptedCodeOfConduct: false }],
    ["missing terms", { acceptedCodeOfConduct: undefined }],
    ["string terms", { acceptedCodeOfConduct: "true" }],
  ])("rejects %s before creating an account", async (_label, overrides) => {
    const response = await POST(request({ ...signup, ...overrides }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(mocks.registerUser).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it.each(["role", "status", "balanceMilli", "realizedPnlMilli", "emailVerifiedAt", "id", "leaderboardScore", "wallet", "__proto__"])("rejects injected %s before account creation", async (field) => {
    const response = await POST(request({ ...signup, [field]: "attacker-controlled" }));
    expect(response.status).toBe(400);
    expect(mocks.registerUser).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });

  it("continues rejecting cross-origin registration", async () => {
    const response = await POST(request(signup, "https://untrusted.example"));

    expect(response.status).toBe(403);
    expect(mocks.registerUser).not.toHaveBeenCalled();
  });

  it.each(["", "short", `${"x".repeat(43)}.${"y".repeat(43)}`])("requires a valid server-issued device cookie", async (cookie) => {
    const base = request(signup);
    const headers = new Headers(base.headers);
    if (cookie) headers.set("cookie", `goosey_registration_device=${cookie}`);
    else headers.delete("cookie");
    const response = await POST(new NextRequest(base.url, { method: "POST", headers, body: JSON.stringify(signup) }));
    expect(response.status).toBe(400);
    expect(mocks.registerUser).not.toHaveBeenCalled();
  });

  it("returns a specific conflict without issuing cookies when this device already registered", async () => {
    mocks.registerUser.mockRejectedValue(new RegistrationDeviceInUseError());
    const response = await POST(request({ ...signup, email: "another@example.com", username: "another_user" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "DEVICE_ACCOUNT_EXISTS" } });
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
    expect(mocks.setRegistrationDeviceCookie).not.toHaveBeenCalled();
  });
});
