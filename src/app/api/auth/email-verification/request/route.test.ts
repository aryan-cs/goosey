import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requestEmailVerification: vi.fn(),
  enforceRateLimit: vi.fn(),
}));

vi.mock("@/lib/auth-recovery", () => ({
  requestEmailVerification: mocks.requestEmailVerification,
}));

vi.mock("@/lib/email", () => {
  class EmailDeliveryError extends Error {
    constructor() {
      super("delivery failed");
      this.name = "EmailDeliveryError";
    }
  }
  return { EmailDeliveryError };
});

vi.mock("@/lib/security", () => ({
  InvalidOriginError: class InvalidOriginError extends Error {},
  RateLimitError: class RateLimitError extends Error {
    readonly retryAfterSeconds = 1;
  },
  assertMutationOrigin: vi.fn(),
  canonicalizeEmail: vi.fn((value: unknown) =>
    typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : null),
  enforceRateLimit: mocks.enforceRateLimit,
  identityRateLimitKey: vi.fn((scope: string, identity: string) => `${scope}:${identity}`),
  requestRateLimitKey: vi.fn((_request: Request, scope: string) => `${scope}:request`),
}));

import { EmailDeliveryError } from "@/lib/email";
import { POST } from "./route";

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost:8080/api/auth/email-verification/request", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8080" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/email-verification/request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enforceRateLimit.mockResolvedValue(undefined);
    mocks.requestEmailVerification.mockResolvedValue(undefined);
  });

  it("passes the canonical email and preserved local destination to the service", async () => {
    const response = await POST(request({ email: "  USER@Example.COM ", next: "/portfolio/activity?tab=fills#recent" }));

    expect(response.status).toBe(202);
    expect(mocks.requestEmailVerification).toHaveBeenCalledWith(
      "user@example.com",
      "/portfolio/activity?tab=fills#recent",
    );
  });

  it("keeps the existing email-only request contract", async () => {
    const response = await POST(request({ email: "user@example.com" }));

    expect(response.status).toBe(202);
    expect(mocks.requestEmailVerification).toHaveBeenCalledWith("user@example.com", "/");
  });

  it("normalizes an external destination to the product root", async () => {
    const response = await POST(request({ email: "user@example.com", next: "https://attacker.example/portfolio" }));

    expect(response.status).toBe(202);
    expect(mocks.requestEmailVerification).toHaveBeenCalledWith("user@example.com", "/");
  });

  it.each([
    ["repeated", ["/portfolio", "/watchlist"]],
    ["numeric", 123],
    ["null", null],
  ])("rejects a %s next value", async (_label, next) => {
    const response = await POST(request({ email: "user@example.com", next }));

    expect(response.status).toBe(400);
    expect(mocks.requestEmailVerification).not.toHaveBeenCalled();
  });

  it("rejects a destination longer than 2048 characters", async () => {
    const response = await POST(request({ email: "user@example.com", next: `/${"a".repeat(2048)}` }));

    expect(response.status).toBe(400);
    expect(mocks.requestEmailVerification).not.toHaveBeenCalled();
  });

  it("maps delivery failure to the existing unavailable response", async () => {
    mocks.requestEmailVerification.mockRejectedValue(new EmailDeliveryError());

    const response = await POST(request({ email: "user@example.com", next: "/portfolio" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "EMAIL_UNAVAILABLE" } });
  });
});
