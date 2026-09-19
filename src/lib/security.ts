import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db";

const EMAIL_MAX_LENGTH = 254;
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_]{1,22}[a-z0-9])$/;
const RATE_LIMIT_KEY_SECRET =
  process.env.RATE_LIMIT_KEY_SECRET ?? process.env.AUTH_SECRET ?? "goosey-local-rate-limit-key";
const TOKEN_DERIVATION_SECRET =
  process.env.GOOSEY_TOKEN_SECRET ?? process.env.AUTH_SECRET ?? "goosey-local-token-derivation-key";

export class InvalidOriginError extends Error {
  constructor() {
    super("Invalid request origin");
    this.name = "InvalidOriginError";
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("Too many requests");
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deterministicSecretToken(purpose: string, identity: string): string {
  if (process.env.NODE_ENV === "production" && !process.env.GOOSEY_TOKEN_SECRET && !process.env.AUTH_SECRET) {
    throw new Error("GOOSEY_TOKEN_SECRET or AUTH_SECRET must be configured in production");
  }
  return createHmac("sha256", TOKEN_DERIVATION_SECRET)
    .update(`${purpose}\u0000${identity.normalize("NFKC")}`, "utf8")
    .digest("base64url");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function canonicalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH || /[\s\u0000-\u001f\u007f]/u.test(email)) {
    return null;
  }

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@")) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!local || local.length > 64 || !domain || domain.length > 253) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return null;
  if (!domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
    return null;
  }
  return email;
}

export function canonicalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().normalize("NFKC").toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

export function normalizeDisplayName(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return null;
  const displayName = value.trim().normalize("NFKC").replace(/\s+/g, " ");
  if (displayName.length < 2 || displayName.length > 40 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
    return null;
  }
  return displayName;
}

export function isValidPassword(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 72) return false;
  return Buffer.byteLength(value, "utf8") <= 72;
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function allowedOrigins(request: NextRequest): Set<string> {
  const origins = new Set<string>();
  const configured = [process.env.APP_URL, process.env.NEXT_PUBLIC_APP_URL];
  for (const value of configured) {
    if (!value) continue;
    const origin = normalizedOrigin(value);
    if (origin) origins.add(origin);
  }

  if (process.env.NODE_ENV !== "production") {
    origins.add(request.nextUrl.origin);
  }
  return origins;
}

export function assertMutationOrigin(request: NextRequest): void {
  const originHeader = request.headers.get("origin");
  const origin = originHeader ? normalizedOrigin(originHeader) : null;
  if (!origin || !allowedOrigins(request).has(origin)) {
    throw new InvalidOriginError();
  }
}

function trustedClientAddress(request: NextRequest): string {
  const trustProxy = process.env.TRUST_PROXY === "1" || Boolean(process.env.VERCEL);
  if (!trustProxy) return "unavailable";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unavailable";
}

function privateRateLimitKey(namespace: string, identity: string): string {
  if (process.env.NODE_ENV === "production" && !process.env.RATE_LIMIT_KEY_SECRET && !process.env.AUTH_SECRET) {
    throw new Error("RATE_LIMIT_KEY_SECRET or AUTH_SECRET must be configured in production");
  }
  const digest = createHmac("sha256", RATE_LIMIT_KEY_SECRET)
    .update(identity.normalize("NFKC"), "utf8")
    .digest("hex");
  return `${namespace}:${digest}`;
}

export function requestRateLimitKey(request: NextRequest, namespace: string): string {
  return privateRateLimitKey(namespace, trustedClientAddress(request));
}

export function identityRateLimitKey(namespace: string, identity: string): string {
  return privateRateLimitKey(namespace, identity);
}

export async function enforceRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new Error("Invalid rate-limit configuration");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date();
    const resetAt = new Date(now.getTime() + windowMs);
    try {
      const result = await db.$transaction(async (tx) => {
        const incremented = await tx.rateLimitBucket.updateMany({
          where: { key, resetAt: { gt: now }, points: { lt: limit } },
          data: { points: { increment: 1 } },
        });
        if (incremented.count === 1) return null;

        const bucket = await tx.rateLimitBucket.findUnique({ where: { key } });
        if (bucket && bucket.resetAt > now) {
          return Math.ceil((bucket.resetAt.getTime() - now.getTime()) / 1_000);
        }

        if (bucket) {
          const reset = await tx.rateLimitBucket.updateMany({
            where: { key, resetAt: { lte: now } },
            data: { points: 1, resetAt },
          });
          if (reset.count === 1) return null;
        } else {
          await tx.rateLimitBucket.create({ data: { key, points: 1, resetAt } });
          return null;
        }

        return 1;
      });

      if (result !== null) throw new RateLimitError(result);
      return;
    } catch (error) {
      if (isPrismaErrorCode(error, "P2002")) {
        continue;
      }
      throw error;
    }
  }

  throw new RateLimitError(Math.ceil(windowMs / 1_000));
}
