import { describe, expect, it } from "vitest";
import { authDestination, authPageHref } from "./auth-destination";

describe("account return destinations", () => {
  it("preserves a product path, query, and fragment through account links", () => {
    const next = "/search?q=Hack%20the%20North#markets";
    expect(authDestination(next)).toBe(next);
    expect(authPageHref("/signup", next)).toBe(`/signup?next=${encodeURIComponent(next)}`);
    expect(authPageHref("/login", undefined)).toBe("/login");
  });

  it.each([
    undefined, ["/portfolio", "/watchlist"], "https://example.org", "//example.org",
    "/\\example.org", "/%5cexample.org", "/%2fexample.org", "/%0a/example.org",
    "javascript:alert(1)", "/login?next=/portfolio", "/verify-email", "/signup/",
    "/x/../api/auth/logout", "/api/health", "/%61pi/health", "/reset-password", "/%xx",
  ])("falls back for unsafe or looping destination %s", (value) => {
    expect(authDestination(value)).toBe("/");
  });
});
