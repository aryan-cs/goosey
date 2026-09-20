import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: { id: "admin-1", role: "ADMIN", status: "ACTIVE" },
  readJsonObject: vi.fn(), debitUserBalance: vi.fn(), findUnique: vi.fn(),
}));

vi.mock("@/lib/admin-service", async () => {
  const { ApiError } = await import("@/lib/market-service");
  return { assertAdmin: (user: { role: string; status: string }) => { if (user.role !== "ADMIN" || user.status !== "ACTIVE") throw new ApiError(403, "ADMIN_REQUIRED", "Administrator required."); } };
});
vi.mock("@/lib/admin-balance-adjustment", () => ({
  balanceDebitSchema: { parse: vi.fn((value: unknown) => value) }, debitUserBalance: mocks.debitUserBalance,
}));
vi.mock("@/lib/http", () => ({ readJsonObject: mocks.readJsonObject }));
vi.mock("@/lib/security", () => ({
  canonicalizeUsername: vi.fn((value: unknown) => typeof value === "string" ? value : null),
  constantTimeEqual: vi.fn((left: string, right: string) => left === right),
}));
vi.mock("@/lib/market-service", () => {
  class ApiError extends Error { constructor(public readonly status: number, public readonly code: string, message: string) { super(message); } }
  return {
    ApiError,
    requireUser: vi.fn(async () => mocks.principal), consumeRateLimit: vi.fn(), parseIdempotencyKey: vi.fn(() => "balance-adjustment-key-1"),
    jsonResponse: vi.fn((value: unknown, init?: ResponseInit) => Response.json(value, init)),
    apiErrorResponse: vi.fn((error: unknown) => { const value = error as { status?: number; code?: string; message?: string }; return Response.json({ error: { code: value.code, message: value.message } }, { status: value.status ?? 500 }); }),
    prisma: { user: { findUnique: mocks.findUnique } },
  };
});

import { POST } from "./route";

function request(authorization?: string): never {
  return new Request("http://localhost:8080/api/admin/balance-adjustments", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8080", ...(authorization ? { authorization } : {}) }, body: "{}" }) as never;
}

describe("admin balance adjustment route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.principal = { id: "admin-1", role: "ADMIN", status: "ACTIVE" };
    mocks.readJsonObject.mockResolvedValue({ username: "bubbly", amountMilli: 3_000_000n, reason: "Reverse event credit", principalTreatment: "REVERSE_GRANT" });
    mocks.debitUserBalance.mockResolvedValue({ journalId: "journal-1", username: "bubbly", balanceMilli: 48_570n, replayed: false });
  });
  afterEach(() => { delete process.env.GOOSEY_OPERATOR_API_TOKEN; delete process.env.GOOSEY_OPERATOR_ACTOR_USERNAME; });

  it("rejects an unconfigured bearer before reading the mutation body", async () => {
    const response = await POST(request(`Bearer ${"a".repeat(43)}`));
    expect(response.status).toBe(401); expect(mocks.readJsonObject).not.toHaveBeenCalled(); expect(mocks.debitUserBalance).not.toHaveBeenCalled();
  });

  it("uses an active administrator session and preserves the session recheck", async () => {
    const incoming = request(); const response = await POST(incoming);
    expect(response.status).toBe(201);
    expect(mocks.debitUserBalance).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "admin-1", sessionRequest: incoming }));
  });

  it("accepts the configured operator token only for a configured active administrator", async () => {
    process.env.GOOSEY_OPERATOR_API_TOKEN = "b".repeat(43); process.env.GOOSEY_OPERATOR_ACTOR_USERNAME = "goosey-admin";
    mocks.findUnique.mockResolvedValue({ id: "operator-admin", role: "ADMIN", status: "ACTIVE" });
    const response = await POST(request(`Bearer ${"b".repeat(43)}`));
    expect(response.status).toBe(201);
    expect(mocks.debitUserBalance).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "operator-admin", sessionRequest: undefined }));
  });
});
