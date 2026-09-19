import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assertMutationOrigin, InvalidOriginError, requestRateLimitKey } from "./security";
import { InvalidRequestError, MAX_AUTH_BODY_BYTES, readJsonObject } from "./http";
import { ApiError, apiErrorResponse, jsonResponse } from "./market-service";

afterEach(() => vi.unstubAllEnvs());

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://goosey.example/api/profile", { method: "PATCH", headers });
}

describe("hostile request boundaries", () => {
  it.each([undefined, "null", "https://evil.example", "https://goosey.example.evil.example", "https://goosey.example@evil.example", "https://goosey.example/path"])("rejects untrusted origin %s even with forged forwarding headers", (origin) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://goosey.example");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://goosey.example");
    expect(() => assertMutationOrigin(request({ ...(origin ? { origin } : {}), host: "evil.example", "x-forwarded-host": "goosey.example", "x-forwarded-proto": "https" }))).toThrow(InvalidOriginError);
  });

  it("accepts the configured origin and fails closed with no production origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://goosey.example");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(() => assertMutationOrigin(request({ origin: "https://goosey.example" }))).not.toThrow();
    vi.stubEnv("APP_URL", "");
    expect(() => assertMutationOrigin(request({ origin: "https://goosey.example" }))).toThrow(InvalidOriginError);
  });

  it("ignores spoofed client IP headers when no trusted proxy is configured", () => {
    vi.stubEnv("TRUST_PROXY", "0");
    vi.stubEnv("VERCEL", "");
    const a = requestRateLimitKey(request({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "1.2.3.4" }), "login");
    const b = requestRateLimitKey(request({ "x-forwarded-for": "5.6.7.8", "x-real-ip": "5.6.7.8" }), "login");
    expect(a).toBe(b);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])("rejects simple-request content type %s", async (contentType) => {
    await expect(readJsonObject(new Request("https://goosey.example/api/profile", { method: "PATCH", headers: { "content-type": contentType }, body: '{"role":"ADMIN"}' }))).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it.each(["null", "[]", "42", "{broken"])("rejects invalid JSON objects: %s", async (body) => {
    await expect(readJsonObject(new Request("https://goosey.example/api/profile", { method: "PATCH", headers: { "content-type": "application/json" }, body }))).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("caps actual streamed bytes even when content-length lies", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(MAX_AUTH_BODY_BYTES + 1)); },
      cancel() { canceled = true; },
    });
    const req = new Request("https://goosey.example/api/profile", { method: "PATCH", headers: { "content-type": "application/json", "content-length": "1" }, body, duplex: "half" } as RequestInit);
    await expect(readJsonObject(req)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(canceled).toBe(true);
  });

  it("keeps API successes and authorization errors out of shared caches", () => {
    expect(jsonResponse({ balanceMilli: 1000n }).headers.get("cache-control")).toBe("private, no-store");
    expect(apiErrorResponse(new ApiError(403, "FORBIDDEN", "Denied")).headers.get("cache-control")).toBe("private, no-store");
    expect(jsonResponse({}, { headers: { "Cache-Control": "public, max-age=60" } }).headers.get("cache-control")).toBe("public, max-age=60");
  });
});
