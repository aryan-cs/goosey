import { createHash } from "node:crypto";

const EMAIL_MAX_LENGTH = 254;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])$/;

/** Pure helpers that are safe to import before database startup. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(email)) return null;

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64 || !domain || domain.length > 253) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (!domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return email;
}

export function canonicalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().normalize("NFKC").toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

export function isValidPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 72) return false;
  return Buffer.byteLength(value, "utf8") <= 72;
}
