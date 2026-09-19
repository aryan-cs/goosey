import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), parseIdempotencyKey: vi.fn(), findMarket: vi.fn(),
  acceptManagedOrder: vi.fn(), dispatchManagedOrderCommand: vi.fn(), placeOrder: vi.fn(), after: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});

vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser, parseIdempotencyKey: mocks.parseIdempotencyKey,
    prisma: { market: { findUnique: mocks.findMarket } } };
});
vi.mock("@/lib/order-exchange", () => ({ placeOrder: mocks.placeOrder, cancelAllOrders: vi.fn() }));
vi.mock("@/lib/order-service", () => ({ listUserOrders: vi.fn(), parseListOrdersQuery: vi.fn() }));
vi.mock("@/lib/solana/managed-order-service", () => ({ acceptManagedOrder: mocks.acceptManagedOrder }));
vi.mock("@/lib/solana/managed-order-dispatcher", () => ({ dispatchManagedOrderCommand: mocks.dispatchManagedOrderCommand }));

import { POST } from "./route";

const payload = { marketSlug: "chain-market", clientOrderId: "client-order-123", outcome: "YES", action: "BUY",
  limitPriceMilli: "450", quantity: 2, timeInForce: "GTC", postOnly: false,
  selfTradePrevention: "CANCEL_AGGRESSOR", expiresAt: null, cancelOnPause: true, reduceOnly: false };

function request() {
  return new NextRequest("http://localhost/api/v1/orders", { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "idempotency-key": "request-key-123456" },
    body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.parseIdempotencyKey.mockReturnValue("request-key-123456");
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatchManagedOrderCommand.mockResolvedValue({ status: "SUBMITTED" });
});

describe("POST /api/v1/orders managed settlement", () => {
  it("routes a Solana-backed market into the durable managed command path", async () => {
    mocks.findMarket.mockResolvedValue({ id: "market_1", executionBackend: "SOLANA" });
    mocks.acceptManagedOrder.mockResolvedValue({ accepted: true, pending: true,
      command: { id: "cmd_123", status: "ACCEPTED" } });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, pending: true,
      command: { id: "cmd_123", status: "ACCEPTED" } });
    expect(mocks.acceptManagedOrder).toHaveBeenCalledWith({ userId: "user_12345678",
      marketSlug: "chain-market", idempotencyKey: "request-key-123456",
      request: expect.objectContaining({ limitPriceMilli: "450", quantity: 2 }) });
    expect(mocks.placeOrder).not.toHaveBeenCalled();
    expect(mocks.dispatchManagedOrderCommand).toHaveBeenCalledWith("cmd_123");
  });

  it("preserves the database exchange path for legacy markets during migration", async () => {
    mocks.findMarket.mockResolvedValue({ id: "market_1", executionBackend: "DATABASE" });
    mocks.placeOrder.mockResolvedValue({ accepted: true, order: { id: "order_1" } });
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.placeOrder).toHaveBeenCalledOnce();
    expect(mocks.acceptManagedOrder).not.toHaveBeenCalled();
  });
});
