import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ loginUser: vi.fn(), setSessionCookie: vi.fn(), enforceRateLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ loginUser: mocks.loginUser, setSessionCookie: mocks.setSessionCookie, emailVerificationState: () => ({ required: false }) }));
vi.mock("@/lib/security", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/security")>(), enforceRateLimit: mocks.enforceRateLimit }));
import { POST } from "./route";

const credentials = { email: "hacker@example.com", password: "correct horse battery staple" };
function request(body: unknown) {
  return new NextRequest("http://localhost:8080/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080" }, body: JSON.stringify(body) });
}

describe("login request tampering", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enforceRateLimit.mockResolvedValue(undefined); });
  it.each(["userId", "role", "balanceMilli", "emailVerifiedAt", "session", "token"])("rejects client-supplied %s before credentials or cookies are issued", async (field) => {
    const response = await POST(request({ ...credentials, [field]: "forged" }));
    expect(response.status).toBe(400);
    expect(mocks.loginUser).not.toHaveBeenCalled();
    expect(mocks.setSessionCookie).not.toHaveBeenCalled();
  });
  it("continues accepting only server-authenticated credentials", async () => {
    mocks.loginUser.mockResolvedValue({ user: { id: "server-user", role: "USER" }, session: { token: "server-session" } });
    const response = await POST(request(credentials));
    expect(response.status).toBe(200);
    expect(mocks.loginUser).toHaveBeenCalledWith({ ...credentials, userAgent: null });
    expect(mocks.setSessionCookie).toHaveBeenCalledOnce();
  });
});
