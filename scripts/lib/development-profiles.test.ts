import { describe, expect, it } from "vitest";
import { DEVELOPMENT_PROFILES, isDevelopmentIdentity } from "./development-profiles";

describe("synthetic identity publication boundary", () => {
  it("accepts canonical and legacy handles only for their original email and role", () => {
    for (const profile of DEVELOPMENT_PROFILES) {
      expect(isDevelopmentIdentity(profile)).toBe(true);
      expect(isDevelopmentIdentity({ ...profile, username: profile.legacyUsername })).toBe(true);
      expect(isDevelopmentIdentity({ ...profile, role: profile.role === "USER" ? "ADMIN" : "USER" })).toBe(false);
      expect(isDevelopmentIdentity({ ...profile, email: "real@example.com" })).toBe(false);
      expect(isDevelopmentIdentity({ ...profile, username: "unrelated-account" })).toBe(false);
    }
  });
  it("rejects unknown numbered accounts and swapped identities", () => {
    expect(isDevelopmentIdentity({ email: "simulation-trader-99@example.test", username: "simulation-trader-99", role: "USER" })).toBe(false);
    expect(isDevelopmentIdentity({ ...DEVELOPMENT_PROFILES[0], username: DEVELOPMENT_PROFILES[1].username })).toBe(false);
  });
  it("keeps login emails and public handles unique", () => {
    expect(new Set(DEVELOPMENT_PROFILES.map(p => p.email)).size).toBe(DEVELOPMENT_PROFILES.length);
    expect(new Set(DEVELOPMENT_PROFILES.map(p => p.username)).size).toBe(DEVELOPMENT_PROFILES.length);
  });
});
