import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), parseKey: vi.fn(), rate: vi.fn(), accept: vi.fn(),
  dispatch: vi.fn(), after: vi.fn() }));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser, parseIdempotencyKey: mocks.parseKey,
    consumeRateLimit: mocks.rate, prisma: {} };
});
vi.mock("@/lib/solana/managed-transfer-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana/managed-transfer-service")>(
    "@/lib/solana/managed-transfer-service",
  );
  return { ...actual, acceptManagedFeatherTransfer: mocks.accept };
});
vi.mock("@/lib/solana/managed-transfer-dispatcher", () => ({
  dispatchManagedFeatherTransferCommand: mocks.dispatch,
}));

import { POST } from "./route";
import { ApiError } from "@/lib/market-service";

function request(body: unknown = { recipientUserId: "recipient_12345678", amount: "12.345" }) {
  return new NextRequest("http://localhost/api/v1/transfers", { method: "POST", headers: {
    "content-type": "application/json", origin: "http://localhost", "idempotency-key": "transfer-request-123",
  }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "sender_12345678" });
  mocks.parseKey.mockReturnValue("transfer-request-123");
  mocks.rate.mockResolvedValue(undefined);
  mocks.accept.mockResolvedValue({ accepted: true, pending: true,
    command: { id: "command_12345678", status: "ACCEPTED" } });
  mocks.dispatch.mockResolvedValue({ status: "SUBMITTED" });
  mocks.after.mockImplementation((callback: () => unknown) => callback());
});

describe("POST /api/v1/transfers", () => {
  it("accepts a durable authenticated transfer and schedules fenced dispatch", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, pending: true,
      command: { id: "command_12345678", status: "ACCEPTED" } });
    expect(mocks.accept).toHaveBeenCalledWith({ senderUserId: "sender_12345678",
      idempotencyKey: "transfer-request-123",
      request: { recipientUserId: "recipient_12345678", amount: "12.345" } });
    expect(mocks.rate).toHaveBeenCalledWith({}, "managed-feather-transfer:sender_12345678", 20, 60_000);
    expect(mocks.dispatch).toHaveBeenCalledWith("command_12345678");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not schedule dispatch if validation or durable acceptance fails", async () => {
    expect((await POST(request({ recipientUserId: "recipient_12345678", amount: "1", extra: true }))).status).toBe(400);
    mocks.accept.mockRejectedValueOnce(new Error("journal unavailable"));
    expect((await POST(request())).status).toBe(500);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("authenticates and rate-limits before command acceptance", async () => {
    mocks.rate.mockRejectedValueOnce(new ApiError(429, "RATE_LIMITED", "Too many requests.", { retryAfter: 30 }));
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
