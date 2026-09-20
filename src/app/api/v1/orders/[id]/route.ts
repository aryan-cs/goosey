import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readJsonObject } from "@/lib/http";
import { cancelOrder, replaceOrder } from "@/lib/order-exchange";
import { ApiError, apiErrorResponse, jsonResponse, parseIdempotencyKey, requireUser } from "@/lib/market-service";
import { dispatchManagedAmendmentCommand } from "@/lib/solana/managed-amendment-dispatcher";
import { acceptManagedAmendment } from "@/lib/solana/managed-amendment-service";
import { dispatchManagedCancellationCommand } from "@/lib/solana/managed-cancellation-dispatcher";
import { acceptManagedCancellation, parseManagedCancellationReference } from "@/lib/solana/managed-cancellation-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
    const managedReference = parseManagedCancellationReference(id);
    if (managedReference) {
      const result = await acceptManagedCancellation({ userId: user.id, orderReference: managedReference,
        idempotencyKey, ...(version === undefined ? {} : { expectedVersion: version }) });
      after(async () => {
        await dispatchManagedCancellationCommand(result.command.id).catch(() => {
          console.error("Managed cancellation dispatch failed; the durable command remains recoverable.", result.command.id);
        });
      });
      return privateNoStore(jsonResponse(result, { status: 202 }));
    }
    const result = await cancelOrder({
      userId: user.id,
      authRequest: request,
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
    const idempotencyKey = parseIdempotencyKey(request);
    const { id } = paramsSchema.parse(await context.params);
    const version = expectedVersion(request);
    if (version === undefined) {
      throw new ApiError(428, "PRECONDITION_REQUIRED", "Order replacement requires an If-Match order version.");
    }
    const body = replaceSchema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    const managedReference = parseManagedCancellationReference(id);
    if (managedReference) {
      const result = await acceptManagedAmendment({ userId: user.id, orderReference: managedReference,
        idempotencyKey, expectedVersion: version, request: body });
      after(async () => {
        await dispatchManagedAmendmentCommand(result.command.id).catch(() => {
          console.error("Managed amendment dispatch failed; the durable command remains recoverable.", result.command.id);
        });
      });
      return privateNoStore(jsonResponse(result, { status: 202 }));
    }
    const result = await replaceOrder({
      userId: user.id,
      authRequest: request,
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
