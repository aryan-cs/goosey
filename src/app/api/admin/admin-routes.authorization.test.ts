import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: { id: "user-attacker", role: "USER", status: "ACTIVE" },
  readJsonObject: vi.fn(),
  createAdminMarket: vi.fn(),
  transitionAdminMarket: vi.fn(),
  createResolutionProposal: vi.fn(),
  approveResolutionProposal: vi.fn(),
  rejectResolutionProposal: vi.fn(),
  getSettlementRun: vi.fn(),
  processSettlementRun: vi.fn(),
  registrationInviteFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/market-service", () => {
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    requireUser: vi.fn().mockImplementation(async () => mocks.principal),
    apiErrorResponse: vi.fn().mockImplementation((error: unknown) => {
      const candidate = error as { status?: number; code?: string; message?: string };
      return Response.json(
        { error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.message ?? "error" } },
        { status: candidate.status ?? 500 },
      );
    }),
    jsonResponse: vi.fn().mockImplementation((value: unknown, init?: ResponseInit) => Response.json(value, init)),
    parseIdempotencyKey: vi.fn().mockReturnValue("hostile-idempotency-key"),
    consumeRateLimit: vi.fn().mockResolvedValue(undefined),
    prisma: {
      registrationInvite: { findMany: mocks.registrationInviteFindMany },
      user: { findUnique: vi.fn() },
      $transaction: mocks.transaction,
    },
  };
});

vi.mock("@/lib/admin-service", async () => {
  const { ApiError } = await import("@/lib/market-service");
  return {
    assertAdmin: (user: { role: string; status: string }) => {
      if (user.role !== "ADMIN" || user.status !== "ACTIVE") {
        throw new ApiError(403, "ADMIN_REQUIRED", "An active administrator account is required.");
      }
    },
    createMarketSchema: { parse: vi.fn((value: unknown) => value) },
    lifecycleReasonSchema: { parse: vi.fn((value: unknown) => value) },
    resolutionSchema: { parse: vi.fn((value: unknown) => value) },
    createAdminMarket: mocks.createAdminMarket,
    transitionAdminMarket: mocks.transitionAdminMarket,
    createResolutionProposal: mocks.createResolutionProposal,
    approveResolutionProposal: mocks.approveResolutionProposal,
    rejectResolutionProposal: mocks.rejectResolutionProposal,
  };
});

vi.mock("@/lib/http", () => ({ readJsonObject: mocks.readJsonObject }));
vi.mock("@/lib/settlement-service", () => ({
  getSettlementRun: mocks.getSettlementRun,
  processSettlementRun: mocks.processSettlementRun,
}));
vi.mock("@/lib/auth", () => ({ verifyPassword: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/security", () => ({
  deterministicSecretToken: vi.fn().mockReturnValue("invite-token"),
  sha256: vi.fn().mockReturnValue("invite-hash"),
}));

import { POST as createMarket } from "./markets/route";
import { POST as pauseMarket } from "./markets/[id]/pause/route";
import { POST as proposeResolution } from "./markets/[id]/resolve/route";
import { POST as reviewResolution } from "./resolution-proposals/[id]/route";
import { GET as listInvites, POST as createInvite } from "./invites/route";
import { GET as getSettlement, POST as processSettlement } from "./settlement-runs/[id]/route";

const RESOURCE_ID = "cm12345678901234567890123";

function request(method: string): never {
  return new Request("http://localhost:8080/api/admin/test", {
    method,
    headers: { "content-type": "application/json", origin: "http://localhost:8080" },
    body: method === "GET" ? undefined : "{}",
  }) as never;
}

const context = { params: Promise.resolve({ id: RESOURCE_ID }) };

describe("hostile admin route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { label: "ordinary user", role: "USER", status: "ACTIVE" },
    { label: "inactive administrator", role: "ADMIN", status: "INACTIVE" },
    { label: "banned administrator", role: "ADMIN", status: "BANNED" },
  ])("blocks $label before parsing or invoking every sensitive mutation", async ({ role, status }) => {
    mocks.principal = { id: "hostile-principal", role, status };

    const responses = await Promise.all([
      createMarket(request("POST")),
      pauseMarket(request("POST"), context),
      proposeResolution(request("POST"), context),
      reviewResolution(request("POST"), context),
      createInvite(request("POST")),
      processSettlement(request("POST"), context),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
    expect(mocks.readJsonObject).not.toHaveBeenCalled();
    expect(mocks.createAdminMarket).not.toHaveBeenCalled();
    expect(mocks.transitionAdminMarket).not.toHaveBeenCalled();
    expect(mocks.createResolutionProposal).not.toHaveBeenCalled();
    expect(mocks.approveResolutionProposal).not.toHaveBeenCalled();
    expect(mocks.rejectResolutionProposal).not.toHaveBeenCalled();
    expect(mocks.processSettlementRun).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    { label: "ordinary user", role: "USER", status: "ACTIVE" },
    { label: "inactive administrator", role: "ADMIN", status: "INACTIVE" },
    { label: "banned administrator", role: "ADMIN", status: "BANNED" },
  ])("blocks $label from privileged reads without disclosing resource existence", async ({ role, status }) => {
    mocks.principal = { id: "hostile-principal", role, status };

    const responses = await Promise.all([
      listInvites(request("GET")),
      getSettlement(request("GET"), context),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(mocks.registrationInviteFindMany).not.toHaveBeenCalled();
    expect(mocks.getSettlementRun).not.toHaveBeenCalled();
  });
});
