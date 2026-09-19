import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readJsonObject } from "@/lib/http";
import { cancelOrder, replaceOrder } from "@/lib/order-exchange";
import { ApiError, apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/) }).strict();
const replaceSchema = z
  .object({
    clientOrderId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
    limitPriceMilli: z.string().regex(/^[1-9]\d{0,17}$/),
    quantity: z.number().int().min(1).max(10_000_000),
    postOnly: z.boolean().optional(),
    selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    cancelOnPause: z.boolean().optional(),
  })
  .strict();

function expectedVersion(request: NextRequest): number | undefined {
  const value = request.headers.get("if-match")?.trim();
  if (!value) return undefined;
  const match = /^"?order-version-(\d+)"?$/.exec(value);
  if (!match) throw new z.ZodError([{ code: "custom", path: ["If-Match"], message: "If-Match must be order-version-N." }]);
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw new z.ZodError([{ code: "custom", path: ["If-Match"], message: "Order version is invalid." }]);
  return version;
}

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const idempotencyKey = parseIdempotencyKey(request);
    const { id } = paramsSchema.parse(await context.params);
    const version = expectedVersion(request);
    const result = await cancelOrder({
      userId: user.id,
      idempotencyKey,
      request: { orderId: id, ...(version === undefined ? {} : { expectedVersion: version }) },
    });
    return privateNoStore(jsonResponse(result));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireUser(request, true);
    const idempotencyKey = parseIdempotencyKey(request);
    const { id } = paramsSchema.parse(await context.params);
    const version = expectedVersion(request);
    if (version === undefined) {
      throw new ApiError(428, "PRECONDITION_REQUIRED", "Order replacement requires an If-Match order version.");
    }
    const body = replaceSchema.parse(await readJsonObject(request));
    const result = await replaceOrder({
      userId: user.id,
      idempotencyKey,
      request: { orderId: id, expectedVersion: version, ...body },
    });
    const rejected =
      typeof result === "object" &&
      result !== null &&
      "accepted" in result &&
      result.accepted === false;
    return privateNoStore(jsonResponse(result, { status: rejected ? 422 : 200 }));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}
