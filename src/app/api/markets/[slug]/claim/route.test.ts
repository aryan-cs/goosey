import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(), requireUser: vi.fn(), marketFindUnique: vi.fn(), accept: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/db", () => ({ db: { market: { findUnique: mocks.marketFindUnique } } }));
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser };
});
vi.mock("@/lib/solana/managed-resolution-service", () => ({ acceptManagedResolutionCommand: mocks.accept }));
vi.mock("@/lib/solana/managed-resolution-dispatcher", () => ({ dispatchManagedResolutionCommand: mocks.dispatch }));

import { POST } from "./route";
import { ApiError } from "@/lib/market-service";

const KEY = "claim-resolution-12345";
const context = { params: Promise.resolve({ slug: "market-one" }) };
function request(key = KEY) {
  return new NextRequest("http://localhost/api/markets/market-one/claim", { method: "POST",
    headers: { origin: "http://localhost", "idempotency-key": key } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678", role: "USER", status: "ACTIVE" });
  mocks.marketFindUnique.mockResolvedValue({ executionBackend: "SOLANA" });
  mocks.accept.mockResolvedValue({ accepted: true, pending: true,
    command: { id: "cmd_claim_12345", operation: "CLAIM_RESOLUTION", status: "ACCEPTED" } });
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatch.mockResolvedValue({ status: "FINALIZED" });
});

describe("POST /api/markets/[slug]/claim", () => {
  it("accepts only the authenticated user's self-claim and returns its status path", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ command: { id: "cmd_claim_12345" },
      statusUrl: "/api/v1/commands/cmd_claim_12345" });
    expect(mocks.accept).toHaveBeenCalledWith({ actorUserId: "user_12345678", marketSlug: "market-one",
      idempotencyKey: KEY, intent: { operation: "CLAIM_RESOLUTION" } });
    expect(response.headers.get("cache-control")).toContain("private");
  });

  it("does not inspect a market or accept a command before authentication", async () => {
    mocks.requireUser.mockRejectedValue(new ApiError(401, "AUTHENTICATION_REQUIRED", "Sign in"));
    const response = await POST(request(), context);
    expect(response.status).toBe(401);
    expect(mocks.marketFindUnique).not.toHaveBeenCalled();
    expect(mocks.accept).not.toHaveBeenCalled();
  });

  it("forwards the same client key on an idempotent retry", async () => {
    await POST(request(), context);
    await POST(request(), context);
    expect(mocks.accept).toHaveBeenNthCalledWith(1, expect.objectContaining({ idempotencyKey: KEY }));
    expect(mocks.accept).toHaveBeenNthCalledWith(2, expect.objectContaining({ idempotencyKey: KEY }));
  });
});
