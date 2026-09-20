import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), parseIdempotencyKey: vi.fn(), cancelOrder: vi.fn(), replaceOrder: vi.fn(),
  acceptCancellation: vi.fn(), dispatchCancellation: vi.fn(), acceptAmendment: vi.fn(),
  dispatchAmendment: vi.fn(), after: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser, parseIdempotencyKey: mocks.parseIdempotencyKey };
});
vi.mock("@/lib/order-exchange", () => ({ cancelOrder: mocks.cancelOrder, replaceOrder: mocks.replaceOrder }));
vi.mock("@/lib/solana/managed-cancellation-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana/managed-cancellation-service")>(
    "@/lib/solana/managed-cancellation-service");
  return { ...actual, acceptManagedCancellation: mocks.acceptCancellation };
});
vi.mock("@/lib/solana/managed-cancellation-dispatcher", () => ({
  dispatchManagedCancellationCommand: mocks.dispatchCancellation,
}));
vi.mock("@/lib/solana/managed-amendment-service", () => ({ acceptManagedAmendment: mocks.acceptAmendment }));
vi.mock("@/lib/solana/managed-amendment-dispatcher", () => ({ dispatchManagedAmendmentCommand: mocks.dispatchAmendment }));

import { encodeManagedCancellationReference } from "@/lib/solana/managed-cancellation-service";
import { DELETE, PATCH } from "./route";

function request(id: string, version?: number) {
  const headers = new Headers({ "Idempotency-Key": "cancel-request-123" });
  if (version !== undefined) headers.set("If-Match", `order-version-${version}`);
  return {
    request: new NextRequest(`http://localhost/api/v1/orders/${encodeURIComponent(id)}`, { method: "DELETE", headers }),
    context: { params: Promise.resolve({ id }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.parseIdempotencyKey.mockReturnValue("cancel-request-123");
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatchCancellation.mockResolvedValue({ status: "FINALIZED" });
  mocks.dispatchAmendment.mockResolvedValue({ status: "FINALIZED" });
});

describe("PATCH /api/v1/orders/[id] managed amendment", () => {
  it("accepts one durable atomic replacement through the ordinary endpoint", async () => {
    const id = encodeManagedCancellationReference({ marketSlug: "market-one", orderId: "42" });
    mocks.acceptAmendment.mockResolvedValue({ accepted: true, pending: true,
      command: { id: "cmd_replace_123", status: "ACCEPTED" } });
    const input = request(id, 9);
    const patchRequest = new NextRequest(input.request.url, { method: "PATCH", headers: {
      "Content-Type": "application/json", "Idempotency-Key": "replace-request-123", "If-Match": "order-version-9",
    }, body: JSON.stringify({ clientOrderId: "replacement-123", limitPriceMilli: "450", quantity: 3,
      postOnly: false, selfTradePrevention: "CANCEL_AGGRESSOR", cancelOnPause: true }) });
    mocks.parseIdempotencyKey.mockReturnValue("replace-request-123");
    const response = await PATCH(patchRequest, input.context);
    expect(response.status).toBe(202);
    expect(mocks.acceptAmendment).toHaveBeenCalledWith({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "replace-request-123",
      expectedVersion: 9, request: expect.objectContaining({ limitPriceMilli: "450", postOnly: false }) });
    expect(mocks.dispatchAmendment).toHaveBeenCalledWith("cmd_replace_123");
    expect(mocks.replaceOrder).not.toHaveBeenCalled();
  });

  it("preserves the database replacement path", async () => {
    mocks.replaceOrder.mockResolvedValue({ accepted: true, order: { orderId: "database_order_123" } });
    const input = request("database_order_123", 3);
    const patchRequest = new NextRequest(input.request.url, { method: "PATCH", headers: {
      "Content-Type": "application/json", "Idempotency-Key": "replace-request-123", "If-Match": "order-version-3",
    }, body: JSON.stringify({ clientOrderId: "replacement-123", limitPriceMilli: "450", quantity: 3 }) });
    mocks.parseIdempotencyKey.mockReturnValue("replace-request-123");
    const response = await PATCH(patchRequest, input.context);
    expect(response.status).toBe(200);
    expect(mocks.replaceOrder).toHaveBeenCalledOnce();
    expect(mocks.acceptAmendment).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/v1/orders/[id] managed cancellation", () => {
  it("uses the ordinary endpoint while accepting and scheduling a managed cancellation", async () => {
    const id = encodeManagedCancellationReference({ marketSlug: "market-one", orderId: "42" });
    mocks.acceptCancellation.mockResolvedValue({ accepted: true, pending: true,
      command: { id: "cmd_cancel_123", status: "ACCEPTED" } });
    const input = request(id, 9);
    const response = await DELETE(input.request, input.context);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, pending: true,
      command: { id: "cmd_cancel_123" } });
    expect(mocks.acceptCancellation).toHaveBeenCalledWith({ userId: "user_12345678",
      orderReference: { marketSlug: "market-one", orderId: "42" }, idempotencyKey: "cancel-request-123",
      expectedVersion: 9 });
    expect(mocks.dispatchCancellation).toHaveBeenCalledWith("cmd_cancel_123");
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("preserves the existing database cancellation path", async () => {
    mocks.cancelOrder.mockResolvedValue({ order: { id: "database_order_123" }, canceledQuantity: 1 });
    const input = request("database_order_123", 3);
    const response = await DELETE(input.request, input.context);
    expect(response.status).toBe(200);
    expect(mocks.cancelOrder).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_12345678",
      idempotencyKey: "cancel-request-123", request: { orderId: "database_order_123", expectedVersion: 3 } }));
    expect(mocks.acceptCancellation).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("fails closed on malformed managed identities instead of falling back to SQL", async () => {
    const input = request("g1.not-canonical");
    const response = await DELETE(input.request, input.context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_ORDER_ID");
    expect(mocks.cancelOrder).not.toHaveBeenCalled();
    expect(mocks.acceptCancellation).not.toHaveBeenCalled();
  });
});
