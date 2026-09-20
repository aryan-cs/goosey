import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), parseIdempotencyKey: vi.fn(), findMarket: vi.fn(),
  acceptManagedOrder: vi.fn(), dispatchManagedOrderCommand: vi.fn(), placeOrder: vi.fn(), after: vi.fn(),
  parseListOrdersQuery: vi.fn(), listUserOrders: vi.fn(), listManagedSolanaOrders: vi.fn(),
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
vi.mock("@/lib/order-service", () => ({ listUserOrders: mocks.listUserOrders, parseListOrdersQuery: mocks.parseListOrdersQuery }));
vi.mock("@/lib/solana/managed-order-service", () => ({ acceptManagedOrder: mocks.acceptManagedOrder }));
vi.mock("@/lib/solana/managed-order-dispatcher", () => ({ dispatchManagedOrderCommand: mocks.dispatchManagedOrderCommand }));
vi.mock("@/lib/solana/managed-order-read", () => ({ listManagedSolanaOrders: mocks.listManagedSolanaOrders }));

import { GET, POST } from "./route";

const payload = { marketSlug: "chain-market", clientOrderId: "client-order-123", outcome: "YES", action: "BUY",
  limitPriceMilli: "450", quantity: 2, timeInForce: "GTC", postOnly: false,
  selfTradePrevention: "CANCEL_AGGRESSOR", expiresAt: null, cancelOnPause: true, reduceOnly: false };

function request() {
  return new NextRequest("http://localhost/api/v1/orders", { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "idempotency-key": "client-order-123" },
    body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.parseIdempotencyKey.mockReturnValue("client-order-123");
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatchManagedOrderCommand.mockResolvedValue({ status: "SUBMITTED" });
  mocks.listManagedSolanaOrders.mockResolvedValue(null);
});

describe("GET /api/v1/orders managed reads", () => {
  it("uses the managed finalized projection for an exact Solana market", async () => {
    const query = { marketSlug: "chain-market", statuses: ["OPEN"], limit: 50 };
    const projected = { orders: [{ orderId: "g1.chain-market.42" }], nextCursor: null };
    mocks.parseListOrdersQuery.mockReturnValue(query);
    mocks.listManagedSolanaOrders.mockResolvedValue(projected);
    const response = await GET(new NextRequest("http://localhost/api/v1/orders?marketSlug=chain-market"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(projected);
    expect(mocks.listManagedSolanaOrders).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_12345678", marketSlug: "chain-market", statuses: ["OPEN"], limit: 50,
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.listUserOrders).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("private");
  });

  it("preserves database listing and does not run managed reads without an exact market", async () => {
    const query = { limit: 20 };
    const listed = { orders: [{ orderId: "database_order_123" }], nextCursor: null };
    mocks.parseListOrdersQuery.mockReturnValue(query);
    mocks.listUserOrders.mockResolvedValue(listed);
    const response = await GET(new NextRequest("http://localhost/api/v1/orders?limit=20"));
    expect(await response.json()).toEqual(listed);
    expect(mocks.listManagedSolanaOrders).not.toHaveBeenCalled();
    expect(mocks.listUserOrders).toHaveBeenCalledWith({ userId: "user_12345678", limit: 20 });
  });
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
      marketSlug: "chain-market", idempotencyKey: "client-order-123",
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

  it("does not schedule submission when durable command acceptance fails", async () => {
    mocks.findMarket.mockResolvedValue({ id: "market_1", executionBackend: "SOLANA" });
    mocks.acceptManagedOrder.mockRejectedValue(new Error("durable journal unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.dispatchManagedOrderCommand).not.toHaveBeenCalled();
  });
});
