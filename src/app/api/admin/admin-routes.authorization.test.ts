vi.mock("@/lib/mutation-session", () => ({ assertMutationSession: vi.fn() }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertMutationSession } from "@/lib/mutation-session";

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
  requireActiveAdmin: vi.fn(),
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
    requireActiveAdmin: mocks.requireActiveAdmin,
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

vi.mock("@/lib/event-service", () => ({
  createAdminEvent: vi.fn(), updateAdminEvent: vi.fn(), attachMarketToEvent: vi.fn(), detachMarketFromEvent: vi.fn(),
  createEventSchema: { parse: vi.fn() }, updateEventSchema: { parse: vi.fn() }, eventMembershipSchema: { parse: vi.fn() },
}));
vi.mock("@/lib/audit-export", () => ({ readAuditExportPage: vi.fn(), serializeAuditCsv: vi.fn() }));

import { POST as resumeMarket } from "./markets/[id]/resume/route";
import { POST as closeMarket } from "./markets/[id]/close/route";
import { POST as createEvent } from "./events/route";
import { PATCH as updateEvent } from "./events/[id]/route";
import { POST as attachMarket } from "./events/[id]/markets/[marketId]/attach/route";
import { POST as detachMarket } from "./events/[id]/markets/[marketId]/detach/route";
import { DELETE as revokeInvite } from "./invites/[id]/route";
import { PATCH as reviewReport } from "./reports/[id]/route";
import { PATCH as reviewSuggestion } from "./suggestions/[id]/route";
import { GET as listReports } from "./reports/route";
import { GET as listSuggestions } from "./suggestions/route";
import { GET as listProposals } from "./resolution-proposals/route";
import { GET as exportAudit } from "./audit-logs/route";
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
    mocks.readJsonObject.mockReset();
    mocks.transaction.mockReset();
    mocks.requireActiveAdmin.mockReset();
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
      resumeMarket(request("POST"), context),
      closeMarket(request("POST"), context),
      createEvent(request("POST")),
      updateEvent(request("PATCH"), context),
      attachMarket(request("POST"), { params: Promise.resolve({ id: RESOURCE_ID, marketId: RESOURCE_ID }) }),
      detachMarket(request("POST"), { params: Promise.resolve({ id: RESOURCE_ID, marketId: RESOURCE_ID }) }),
      revokeInvite(request("DELETE"), context),
      reviewReport(request("PATCH"), context),
      reviewSuggestion(request("PATCH"), context),
    ]);

    expect(responses.map((response) => response.status)).toEqual(Array(15).fill(403));
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
      listReports(request("GET")),
      listSuggestions(request("GET")),
      listProposals(request("GET")),
      exportAudit(request("GET")),
    ]);

    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(403));
    expect(mocks.registrationInviteFindMany).not.toHaveBeenCalled();
    expect(mocks.getSettlementRun).not.toHaveBeenCalled();
  });

  it.each([
    { label: "invite issuance", method: "POST", body: { label: "Audited invitation" }, invoke: (incoming: never) => createInvite(incoming) },
    { label: "invite revocation", method: "DELETE", body: {}, invoke: (incoming: never) => revokeInvite(incoming, context) },
    { label: "comment moderation", method: "PATCH", body: { action: "HIDE", note: "Moderator explanation" }, invoke: (incoming: never) => reviewReport(incoming, context) },
    { label: "suggestion review", method: "PATCH", body: { action: "APPROVE", note: "Reviewer explanation" }, invoke: (incoming: never) => reviewSuggestion(incoming, context) },
  ])("rechecks a revoked administrator inside $label transaction before any resource access", async ({ method, body, invoke }) => {
    const { ApiError } = await import("@/lib/market-service");
    mocks.principal = { id: "formerly-admin", role: "ADMIN", status: "ACTIVE" };
    mocks.readJsonObject.mockResolvedValue(body);
    const tx = {};
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(tx));
    mocks.requireActiveAdmin.mockRejectedValue(new ApiError(403, "ADMIN_REQUIRED", "Administrator access was revoked."));

    const response = await invoke(request(method));
    expect(response.status).toBe(403);
    expect(assertMutationSession).toHaveBeenCalledWith(tx, expect.anything(), "formerly-admin");
    expect(mocks.requireActiveAdmin).toHaveBeenCalledWith(tx, "formerly-admin");
  });

});
