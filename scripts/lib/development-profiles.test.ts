import { describe, expect, it } from "vitest";
import { DEVELOPMENT_PARTICIPANTS, DEVELOPMENT_PROFILES, isDevelopmentIdentity } from "./development-profiles";

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

  it("publishes the audited 100-account roster with stable fixture emails and equity targets", () => {
    expect(DEVELOPMENT_PARTICIPANTS).toHaveLength(100);
    expect(DEVELOPMENT_PARTICIPANTS[0]).toMatchObject({
      email: "simulation-trader-01@example.test",
      username: "elenakoi",
      displayName: "elenakoi",
      legacyUsername: "simulation-trader-01",
      targetEquityMilli: 1_054_000n,
    });
    expect(DEVELOPMENT_PARTICIPANTS[99]).toMatchObject({
      email: "simulation-trader-100@example.test",
      username: "stoneotter",
      displayName: "stoneotter",
      legacyUsername: "simulation-trader-100",
      targetEquityMilli: 1_164_000n,
    });
    expect(DEVELOPMENT_PARTICIPANTS.reduce((sum, profile) => sum + profile.targetEquityMilli!, 0n)).toBe(101_418_000n);
    expect(Math.min(...DEVELOPMENT_PARTICIPANTS.map(profile => Number(profile.targetEquityMilli)))).toBe(390_000);
    expect(Math.max(...DEVELOPMENT_PARTICIPANTS.map(profile => Number(profile.targetEquityMilli)))).toBe(1_594_000);
  });

  it("rejects unknown numbered accounts and swapped identities", () => {
    expect(isDevelopmentIdentity({ email: "simulation-trader-101@example.test", username: "simulation-trader-101", role: "USER" })).toBe(false);
    expect(isDevelopmentIdentity({ ...DEVELOPMENT_PROFILES[0], username: DEVELOPMENT_PROFILES[1].username })).toBe(false);
  });

  it("keeps login emails and public handles unique", () => {
    expect(new Set(DEVELOPMENT_PROFILES.map(profile => profile.email)).size).toBe(DEVELOPMENT_PROFILES.length);
    expect(new Set(DEVELOPMENT_PROFILES.map(profile => profile.username)).size).toBe(DEVELOPMENT_PROFILES.length);
  });
});
