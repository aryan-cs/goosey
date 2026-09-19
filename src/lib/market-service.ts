import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { emailVerificationState, getAuthenticatedUser, requiresEmailVerification, type PublicUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { InvalidRequestError } from "@/lib/http";
import { assertMutationOrigin, enforceRateLimit, RateLimitError } from "@/lib/security";
import { jsonSafe } from "@/lib/serializers";

export const prisma = db;
export type DatabaseClient = typeof db | Prisma.TransactionClient;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

function errorResponse(
  status: number,
  error: { code: string; message: string; details?: unknown },
  headers?: HeadersInit,
): NextResponse {
  const requestId = randomUUID();
  return NextResponse.json(
    { error: { ...error, requestId } },
    { status, headers: { "Cache-Control": "private, no-store", ...Object.fromEntries(new Headers(headers)), "X-Request-Id": requestId } },
  );
}

export function apiErrorResponse(error: unknown): NextResponse {
  if (error instanceof ApiError) {
    const retryAfter =
      error.code === "RATE_LIMITED" &&
      typeof error.details === "object" &&
      error.details !== null &&
      "retryAfter" in error.details &&
      typeof error.details.retryAfter === "number"
        ? { "Retry-After": String(error.details.retryAfter) }
        : undefined;
    return errorResponse(error.status, {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: jsonSafe(error.details) }),
    }, retryAfter);
  }
  if (error instanceof ZodError) {
    return errorResponse(400, {
      code: "INVALID_REQUEST",
      message: "The request was not valid.",
      details: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (error instanceof InvalidRequestError) {
    return errorResponse(400, { code: "INVALID_REQUEST", message: "The request must be a small JSON object." });
  }
  if (
    isPrismaErrorCode(error, "P2034", "P2028")
  ) {
    return errorResponse(409, {
      code: "RETRYABLE_CONFLICT",
      message: "The request conflicted with another update. Refresh and retry.",
    }, { "Retry-After": "1" });
  }
  if (isPrismaErrorCode(error, "P2002")) {
    return errorResponse(409, {
      code: "CONFLICT",
      message: "The request conflicts with an existing record.",
    });
  }
  console.error("Unhandled API error", error);
  return errorResponse(500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
}

export function jsonResponse(value: unknown, init?: ResponseInit): NextResponse {
  const headers = new Headers(init?.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(jsonSafe(value), { ...init, headers });
}

export function assertSameOrigin(request: NextRequest): void {
  try {
    assertMutationOrigin(request);
  } catch {
    throw new ApiError(403, "INVALID_ORIGIN", "The request origin is not allowed.");
  }
}

export async function requireUser(
  request: NextRequest,
  mutation = false,
): Promise<PublicUser> {
  if (mutation) assertSameOrigin(request);
  const user = await getAuthenticatedUser(request);
  if (!user) throw new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue.");
  if (requiresEmailVerification(user)) {
    throw new ApiError(
      403,
      "EMAIL_VERIFICATION_REQUIRED",
      "Verify your email before using Goosey.",
      emailVerificationState(user),
    );
  }
  return user;
}

export async function consumeRateLimit(
  _db: DatabaseClient,
  key: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  try {
    await enforceRateLimit(key, limit, windowMs);
  } catch (error) {
    if (error instanceof RateLimitError) {
      throw new ApiError(429, "RATE_LIMITED", `Too many requests. Retry in ${error.retryAfterSeconds} seconds.`, { retryAfter: error.retryAfterSeconds });
    }
    throw error;
  }
}

export function parseIdempotencyKey(request: NextRequest): string {
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key || key.length < 16 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ApiError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be 16–200 URL-safe characters.",
    );
  }
  return key;
}

export function principalScopedIdempotencyScope(route: string, userId: string): string {
  return `USER:${userId}:${route}`;
}
