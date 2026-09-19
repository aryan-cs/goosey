import { describe, expect, it } from "vitest";
import { isEmailVerificationRequired } from "@/lib/client-api";

describe("client API verification routing", () => {
  it("matches only the exact protected-action verification response", () => {
    expect(isEmailVerificationRequired(403, { error: { code: "EMAIL_VERIFICATION_REQUIRED" } })).toBe(true);
    expect(isEmailVerificationRequired(403, { error: { code: "FORBIDDEN" } })).toBe(false);
    expect(isEmailVerificationRequired(401, { error: { code: "EMAIL_VERIFICATION_REQUIRED" } })).toBe(false);
    expect(isEmailVerificationRequired(403, null)).toBe(false);
  });
});
