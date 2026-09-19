import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ db: {} }));

import { GET } from "./route";
import { createRegistrationDeviceToken } from "@/lib/security";

function request(cookie?: string) {
  return new NextRequest("https://goosey.example/api/auth/registration-device", {
    headers: cookie ? { cookie: `goosey_registration_device=${cookie}` } : undefined,
  });
}

describe("GET /api/auth/registration-device", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("issues a long-lived opaque HttpOnly cookie with production protections", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "registration-device-route-test-secret");
    const response = await GET(request());
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.cookies.get("goosey_registration_device");
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=157680000");
  });

  it("keeps a valid token and replaces malformed values", async () => {
    const valid = createRegistrationDeviceToken();
    expect((await GET(request(valid))).headers.get("set-cookie")).toBeNull();
    expect((await GET(request("malformed"))).cookies.get("goosey_registration_device")?.value).toMatch(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  });
});
