import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), requireUser: vi.fn(), parseIdempotencyKey: vi.fn(), readJsonObject: vi.fn(),
  accept: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/admin-service", () => ({
  assertAdmin: vi.fn(), createMarketSchema: { parse: vi.fn((value: unknown) => value) },
}));
vi.mock("@/lib/http", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http")>("@/lib/http");
  return { ...actual, readJsonObject: mocks.readJsonObject };
});
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser, parseIdempotencyKey: mocks.parseIdempotencyKey };
});
vi.mock("@/lib/solana/managed-market-provisioning-service", () => ({ acceptManagedMarketProvisioning: mocks.accept }));
vi.mock("@/lib/solana/managed-market-provisioning-dispatcher", () => ({ dispatchManagedMarketProvisioningCommand: mocks.dispatch }));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost:8080/api/admin/markets", { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:8080", "idempotency-key": "market-key-123" },
    body: JSON.stringify({ slug: "chain-market" }) });
}

describe("POST /api/admin/markets Solana provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "admin_123", role: "ADMIN", status: "ACTIVE" });
    mocks.parseIdempotencyKey.mockReturnValue("market-key-123");
    mocks.readJsonObject.mockResolvedValue({ slug: "chain-market" });
    mocks.after.mockImplementation((callback: () => unknown) => callback());
    mocks.dispatch.mockResolvedValue({ status: "SUBMITTED" });
    mocks.accept.mockResolvedValue({ accepted: true, pending: true, replayed: false,
      market: { id: "market_123", executionBackend: "SOLANA" },
      command: { id: "command_123", status: "ACCEPTED" } });
  });

  it("returns the durable command before scheduling bounded background dispatch", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ market: { executionBackend: "SOLANA" },
      command: { id: "command_123", status: "ACCEPTED" } });
    expect(mocks.accept).toHaveBeenCalledWith({ actorUserId: "admin_123", idempotencyKey: "market-key-123",
      market: { slug: "chain-market" } });
    expect(mocks.dispatch).toHaveBeenCalledWith("command_123");
  });

  it("does not schedule new chain work when durable acceptance fails", async () => {
    mocks.accept.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(["PROJECTED", "FAILED_TERMINAL", "UNKNOWN"])("does not auto-dispatch a %s replay", async status => {
    mocks.accept.mockResolvedValueOnce({ accepted: true, pending: false, replayed: true,
      market: { id: "market_123", executionBackend: "SOLANA" }, command: { id: "command_123", status } });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.after).not.toHaveBeenCalled();
  });
});
