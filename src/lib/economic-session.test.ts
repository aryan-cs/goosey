import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  transaction: vi.fn(),
  outsideReplay: vi.fn(),
  tx: {
    idempotencyRequest: { findUnique: vi.fn(), create: vi.fn() },
    orderCommand: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    tradeQuote: { deleteMany: vi.fn() },
  },
}));

vi.mock("@/lib/mutation-session", () => ({ assertMutationSession: mocks.guard }));
vi.mock("@/lib/market-service", () => ({
  ApiError: class ApiError extends Error {},
  consumeRateLimit: vi.fn(),
  principalScopedIdempotencyScope: (route: string, user: string) => `${route}:${user}`,
  prisma: {
    orderCommand: { findUnique: mocks.outsideReplay },
    idempotencyRequest: { findUnique: mocks.outsideReplay },
  },
}));
vi.mock("@/lib/serializable-transaction", () => ({
  runSerializableTransaction: (_client: unknown, operation: (tx: typeof mocks.tx) => Promise<unknown>) => {
    mocks.transaction();
    return operation(mocks.tx);
  },
}));

import { createTradeQuote, executeTrade } from "./trading";
import { redeemCompleteSet } from "./redemption";
import { cancelAllOrders, cancelOrder, placeOrder, replaceOrder } from "./order-exchange";

const authRequest = new NextRequest("http://localhost:8080/api/v1/orders", {
  headers: { cookie: "goosey_session=revoked-test-token" },
});
const userId = "participant_1234";
const marketId = "market_12345678";
const idempotencyKey = "economic-session-test-key";
const envelope = { userId, authRequest, idempotencyKey };
const order = {
  clientOrderId: "session-order-client", outcome: "YES", action: "BUY",
  limitPriceMilli: "50000", quantity: 1,
};
const operations = [
  ["quote creation", () => createTradeQuote({ userId, authRequest, marketId, side: "YES", action: "BUY", quantity: 1 })],
  ["trade execution", () => executeTrade({ ...envelope, marketId, quoteId: "cm12345678901234567890123", maxDebitMilli: 100_000n })],
  ["redemption", () => redeemCompleteSet({ ...envelope, marketId, quantity: 1, marketVersion: 0 })],
  ["order placement", () => placeOrder({ ...envelope, request: { ...order, marketId } })],
  ["order cancellation", () => cancelOrder({ ...envelope, request: { orderId: "order_12345678" } })],
  ["bulk cancellation", () => cancelAllOrders({ ...envelope, request: {} })],
  ["order replacement", () => replaceOrder({ ...envelope, request: { orderId: "order_12345678", expectedVersion: 0, clientOrderId: order.clientOrderId, limitPriceMilli: order.limitPriceMilli, quantity: 1 } })],
] as const;

describe("economic mutations require a live session inside their transaction", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each(operations)("rejects revoked or expired sessions before %s can replay or mutate", async (_label, operation) => {
    const failure = Object.assign(new Error("Sign in to continue."), { status: 401, code: "AUTHENTICATION_REQUIRED" });
    mocks.guard.mockRejectedValue(failure);
    // Even a completed outside-transaction replay must not bypass session validation.
    mocks.outsideReplay.mockResolvedValue({ status: "COMPLETED", responseBody: "{}" });

    await expect(operation()).rejects.toBe(failure);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.guard).toHaveBeenCalledWith(mocks.tx, authRequest, userId);
    expect(mocks.outsideReplay).not.toHaveBeenCalled();
    expect(mocks.tx.idempotencyRequest.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.idempotencyRequest.create).not.toHaveBeenCalled();
    expect(mocks.tx.orderCommand.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.tx.tradeQuote.deleteMany).not.toHaveBeenCalled();
  });
});
