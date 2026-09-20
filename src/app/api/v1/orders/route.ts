import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { readJsonObject } from "@/lib/http";
import { cancelAllOrders, placeOrder } from "@/lib/order-exchange";
import { ApiError, apiErrorResponse, jsonResponse, parseIdempotencyKey, prisma, requireUser } from "@/lib/market-service";
import { listUserOrders, parseListOrdersQuery } from "@/lib/order-service";
import { acceptManagedOrder } from "@/lib/solana/managed-order-service";
import { dispatchManagedOrderCommand } from "@/lib/solana/managed-order-dispatcher";
import { listManagedSolanaOrders } from "@/lib/solana/managed-order-read";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const placeSchema = z
  .object({
    marketSlug: z.string().trim().min(1).max(160).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    clientOrderId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/),
    outcome: z.enum(["YES", "NO"]),
    action: z.enum(["BUY", "SELL"]),
    limitPriceMilli: z.string().regex(/^[1-9]\d{0,17}$/),
    quantity: z.number().int().min(1).max(10_000_000),
    timeInForce: z.enum(["GTC", "IOC", "FOK"]).default("GTC"),
    postOnly: z.boolean().default(false),
    selfTradePrevention: z.enum(["CANCEL_AGGRESSOR", "CANCEL_RESTING", "CANCEL_BOTH"]).default("CANCEL_AGGRESSOR"),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    cancelOnPause: z.boolean().default(true),
    reduceOnly: z.boolean().default(false),
  })
  .strict();

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.append("Vary", "Cookie");
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireUser(request);
    const query = parseListOrdersQuery(request.nextUrl.searchParams);
    const marketSlug = query.marketSlug;
    const managed = marketSlug
      ? await listManagedSolanaOrders({ userId: user.id, ...query, marketSlug, signal: request.signal })
      : null;
    if (managed) return privateNoStore(jsonResponse(managed));
    const result = await listUserOrders({ userId: user.id, ...query });
    return privateNoStore(jsonResponse(result));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const idempotencyKey = parseIdempotencyKey(request);
    const body = placeSchema.parse(await readJsonObject(request));
    const user = await requireUser(request, true);
    const market = await prisma.market.findUnique({
      where: { slug: body.marketSlug },
      select: { id: true, executionBackend: true },
    });
    if (!market) throw new ApiError(404, "MARKET_NOT_FOUND", "Market not found.");
    const { marketSlug: _marketSlug, ...order } = body;
    void _marketSlug;
    if (market.executionBackend === "SOLANA") {
      const result = await acceptManagedOrder({
        userId: user.id,
        marketSlug: body.marketSlug,
        idempotencyKey,
        request: order,
      });
      after(async () => {
        await dispatchManagedOrderCommand(result.command.id).catch(() => {
          console.error("Managed order dispatch failed; the durable command remains retryable.", result.command.id);
        });
      });
      return privateNoStore(jsonResponse(result, { status: 202 }));
    }
    const result = await placeOrder({
      userId: user.id,
      authRequest: request,
      idempotencyKey,
      request: { ...order, marketId: market.id },
    });
    const rejected =
      typeof result === "object" &&
      result !== null &&
      "accepted" in result &&
      result.accepted === false;
    return privateNoStore(jsonResponse(result, { status: rejected ? 422 : 201 }));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const idempotencyKey = parseIdempotencyKey(request);
    const body = await readJsonObject(request);
    const user = await requireUser(request, true);
    const result = await cancelAllOrders({ userId: user.id, authRequest: request, idempotencyKey, request: body });
    return privateNoStore(jsonResponse(result));
  } catch (error) {
    return privateNoStore(apiErrorResponse(error));
  }
}
