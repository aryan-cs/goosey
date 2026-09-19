import { randomUUID } from "node:crypto";

import { isPrismaErrorCode } from "@/lib/prisma-errors";
import { NextResponse } from "next/server";

import { InvalidOriginError, RateLimitError, RegistrationDeviceInUseError } from "@/lib/security";

export const MAX_AUTH_BODY_BYTES = 16 * 1_024;

export class InvalidRequestError extends Error {
  constructor() {
    super("Invalid request");
    this.name = "InvalidRequestError";
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): NextResponse {
  const requestId = randomUUID();
  const response = NextResponse.json({ error: { code, message, requestId } }, { status, headers });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new InvalidRequestError();
  const contentLengthHeader = request.headers.get("content-length");
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_AUTH_BODY_BYTES)
  ) {
    throw new InvalidRequestError();
  }

  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_AUTH_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidRequestError();
      }
      chunks.push(value);
    }
  }
  const rawBody = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  const body = (() => {
    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      return null;
    }
  })();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidRequestError();
  return body as Record<string, unknown>;
}

export function authRouteError(error: unknown): NextResponse {
  if (error instanceof RateLimitError) {
    return jsonError(429, "RATE_LIMITED", "Too many requests. Try again later.", {
      "Retry-After": String(error.retryAfterSeconds),
    });
  }
  if (error instanceof InvalidOriginError) {
    return jsonError(403, "FORBIDDEN", "Request not allowed.");
  }
  if (error instanceof InvalidRequestError) {
    return jsonError(400, "INVALID_REQUEST", "Invalid request.");
  }
  if (error instanceof RegistrationDeviceInUseError) {
    return jsonError(409, "DEVICE_ACCOUNT_EXISTS", "This device has already created an account. Sign in to the existing account instead.");
  }
  if (isPrismaErrorCode(error, "P2002")) {
    return jsonError(409, "ACCOUNT_UNAVAILABLE", "Unable to create this account.");
  }
  return jsonError(500, "INTERNAL_ERROR", "Something went wrong.");
}
