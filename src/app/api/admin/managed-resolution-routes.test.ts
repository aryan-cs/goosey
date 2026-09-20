import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  requireUser: vi.fn(),
  readJsonObject: vi.fn(),
  marketFindUnique: vi.fn(),
  proposalFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  closeDatabase: vi.fn(),
  proposeDatabase: vi.fn(),
  approveDatabase: vi.fn(),
  rejectDatabase: vi.fn(),
  acceptCommand: vi.fn(),
  acceptProposal: vi.fn(),
  acceptApproval: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/http", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http")>("@/lib/http");
  return { ...actual, readJsonObject: mocks.readJsonObject };
});
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser, consumeRateLimit: vi.fn(async () => undefined),
    prisma: { market: { findUnique: mocks.marketFindUnique },
      marketResolutionProposal: { findUnique: mocks.proposalFindUnique }, user: { findUnique: mocks.userFindUnique } } };
});
vi.mock("@/lib/admin-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/admin-service")>("@/lib/admin-service");
  return { ...actual,
    lifecycleReasonSchema: { parse: (value: unknown) => value },
    resolutionSchema: { parse: (value: unknown) => value },
    transitionAdminMarket: mocks.closeDatabase,
    createResolutionProposal: mocks.proposeDatabase,
    approveResolutionProposal: mocks.approveDatabase,
    rejectResolutionProposal: mocks.rejectDatabase,
  };
});
vi.mock("@/lib/auth", () => ({ verifyPassword: vi.fn(async () => true) }));
vi.mock("@/lib/solana/managed-resolution-service", () => ({
  acceptManagedResolutionCommand: mocks.acceptCommand,
  acceptManagedResolutionProposal: mocks.acceptProposal,
  acceptManagedResolutionApproval: mocks.acceptApproval,
}));
vi.mock("@/lib/solana/managed-resolution-dispatcher", () => ({ dispatchManagedResolutionCommand: mocks.dispatch }));

import { POST as close } from "./markets/[id]/close/route";
import { POST as propose } from "./markets/[id]/resolve/route";
import { POST as approve } from "./resolution-proposals/[id]/route";

const ID = "cm12345678901234567890123";
const KEY = "resolution-request-12345";
const context = { params: Promise.resolve({ id: ID }) };
const command = { id: "cmd_resolution_123", operation: "CLOSE_RESOLUTION", status: "ACCEPTED" };

function request(body: unknown, key = KEY) {
  return new NextRequest("http://localhost/api/admin/resource", { method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", "idempotency-key": key },
    body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "admin_12345678", role: "ADMIN", status: "ACTIVE" });
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.userFindUnique.mockResolvedValue({ passwordHash: "hash" });
  mocks.acceptCommand.mockResolvedValue({ accepted: true, pending: true, command });
  mocks.acceptProposal.mockResolvedValue({ accepted: true, pending: true, replayed: false,
    proposal: { id: "proposal_1" }, command: { ...command, operation: "PROPOSE_RESOLUTION" } });
  mocks.acceptApproval.mockResolvedValue({ accepted: true, pending: true, replayed: false,
    proposal: { id: ID }, command: { ...command, operation: "APPROVE_RESOLUTION" } });
});

describe("managed resolution admin routes", () => {
  it("keeps DATABASE close behavior synchronous and unchanged", async () => {
    mocks.readJsonObject.mockResolvedValue({ reason: "Closing normally", expectedVersion: 4 });
    mocks.marketFindUnique.mockResolvedValue({ slug: "market-one", executionBackend: "DATABASE" });
    mocks.closeDatabase.mockResolvedValue({ market: { id: ID, status: "CLOSED" }, replayed: false });
    const response = await close(request({}), context);
    expect(response.status).toBe(200);
    expect(mocks.closeDatabase).toHaveBeenCalledWith({ actorUserId: "admin_12345678", marketId: ID,
      action: "CLOSE", reason: "Closing normally", expectedVersion: 4 });
    expect(mocks.acceptCommand).not.toHaveBeenCalled();
  });

  it("returns a durable command and preserves the exact close idempotency key", async () => {
    mocks.readJsonObject.mockResolvedValue({ reason: "Closing on chain", expectedVersion: 4 });
    mocks.marketFindUnique.mockResolvedValue({ slug: "market-one", executionBackend: "SOLANA" });
    const response = await close(request({}), context);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ command: { id: command.id },
      statusUrl: `/api/v1/commands/${command.id}` });
    expect(mocks.acceptCommand).toHaveBeenCalledWith({ actorUserId: "admin_12345678", marketSlug: "market-one",
      idempotencyKey: KEY, intent: { operation: "CLOSE_RESOLUTION" } });
    expect(mocks.dispatch).toHaveBeenCalledWith(command.id);
  });

  it("derives a stable close retry key for the existing admin console", async () => {
    mocks.readJsonObject.mockResolvedValue({ reason: "Closing on chain", expectedVersion: 4 });
    mocks.marketFindUnique.mockResolvedValue({ slug: "market-one", executionBackend: "SOLANA" });
    const withoutKey = new NextRequest("http://localhost/api/admin/resource", { method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" }, body: "{}" });
    await close(withoutKey, context);
    expect(mocks.acceptCommand).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `admin-close-v1:${ID}:4`,
    }));
  });

  it("branches proposal acceptance without changing DATABASE proposal behavior", async () => {
    const resolution = { outcome: "YES", reason: "Official result", evidence: "Official source" };
    mocks.readJsonObject.mockResolvedValue(resolution);
    mocks.marketFindUnique.mockResolvedValueOnce({ executionBackend: "SOLANA" });
    const managed = await propose(request(resolution), context);
    expect(managed.status).toBe(202);
    expect(mocks.acceptProposal).toHaveBeenCalledWith({ actorUserId: "admin_12345678", marketId: ID,
      idempotencyKey: KEY, resolution });
    mocks.marketFindUnique.mockResolvedValueOnce({ executionBackend: "DATABASE" });
    mocks.proposeDatabase.mockResolvedValue({ proposal: { id: "database-proposal" }, replayed: false });
    const database = await propose(request(resolution), context);
    expect(database.status).toBe(201);
    expect(mocks.proposeDatabase).toHaveBeenCalledOnce();
  });

  it("keeps password step-up and forwards the exact approval idempotency key", async () => {
    mocks.readJsonObject.mockResolvedValue({ action: "APPROVE", note: "", password: "correct-password" });
    mocks.proposalFindUnique.mockResolvedValue({ market: { executionBackend: "SOLANA" } });
    const response = await approve(request({}), context);
    expect(response.status).toBe(202);
    expect(mocks.acceptApproval).toHaveBeenCalledWith({ actorUserId: "admin_12345678", proposalId: ID,
      idempotencyKey: KEY });
    expect(await response.json()).toMatchObject({ command: { operation: "APPROVE_RESOLUTION" },
      statusUrl: `/api/v1/commands/${command.id}` });
  });
});
