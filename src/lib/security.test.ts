import { describe, expect, it } from "vitest";
import { canonicalizeEmail, canonicalizeUsername, constantTimeEqual, deterministicSecretToken, isValidPassword, randomToken, sha256 } from "./security";

describe("identity validation", () => {
  it("canonicalizes ordinary email and rejects malformed variants", () => {
    expect(canonicalizeEmail(" Aryan@UWATERLOO.CA ")).toBe("aryan@uwaterloo.ca");
    for (const value of ["a@@b.ca", "a b@c.ca", ".a@c.ca", "a@localhost", "a@-bad.ca", ""]) {
      expect(canonicalizeEmail(value)).toBeNull();
    }
  });

  it("enforces non-confusable lowercase usernames and password bounds", () => {
    expect(canonicalizeUsername(" Goose_Trader ")).toBe("goose_trader");
    for (const value of ["A", "goose-egg", "goose space", "🪶goose", "_goose", "goose_"]) {
      expect(canonicalizeUsername(value)).toBeNull();
    }
    expect(isValidPassword("correct horse battery staple")).toBe(true);
    expect(isValidPassword("short-pass")).toBe(false);
    expect(isValidPassword("x".repeat(73))).toBe(false);
  });
});

describe("token primitives", () => {
  it("generates 256-bit random bearer tokens and hashes deterministically", () => {
    const one = randomToken();
    const two = randomToken();
    expect(one).not.toBe(two);
    expect(Buffer.from(one, "base64url")).toHaveLength(32);
    expect(sha256(one)).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(one)).toBe(sha256(one));
  });

  it("compares equal-length values without throwing on a length mismatch", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "nope")).toBe(false);
    expect(constantTimeEqual("short", "a much longer string")).toBe(false);
  });

  it("derives stable purpose-separated retry tokens without storing plaintext", () => {
    const retry = deterministicSecretToken("registration-invite", "admin:key");
    expect(Buffer.from(retry, "base64url")).toHaveLength(32);
    expect(deterministicSecretToken("registration-invite", "admin:key")).toBe(retry);
    expect(deterministicSecretToken("another-purpose", "admin:key")).not.toBe(retry);
    expect(deterministicSecretToken("registration-invite", "admin:other-key")).not.toBe(retry);
  });
});
