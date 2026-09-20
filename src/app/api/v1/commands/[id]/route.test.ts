import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), load: vi.fn(), publicStatus: vi.fn(), after: vi.fn(), dispatch: vi.fn(),
  cancelDispatch: vi.fn(), amendmentDispatch: vi.fn(), transferDispatch: vi.fn(),
  marketDispatch: vi.fn(), bookDispatch: vi.fn(),
  resolutionDispatch: vi.fn(),
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mocks.after };
});
vi.mock("@/lib/market-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/market-service")>("@/lib/market-service");
  return { ...actual, requireUser: mocks.requireUser };
});
vi.mock("@/lib/solana/chain-command-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana/chain-command-store")>("@/lib/solana/chain-command-store");
  return { ...actual, PrismaChainCommandStore: class {
    load = mocks.load;
    publicStatus = mocks.publicStatus;
  } };
});
vi.mock("@/lib/solana/managed-order-dispatcher", () => ({ dispatchManagedOrderCommand: mocks.dispatch }));
vi.mock("@/lib/solana/managed-cancellation-dispatcher", () => ({ dispatchManagedCancellationCommand: mocks.cancelDispatch }));
vi.mock("@/lib/solana/managed-market-provisioning-dispatcher", () => ({
  dispatchManagedMarketProvisioningCommand: mocks.marketDispatch,
}));
vi.mock("@/lib/solana/managed-market-book-dispatcher", () => ({
  dispatchManagedMarketBookCommand: mocks.bookDispatch,
}));
vi.mock("@/lib/solana/managed-resolution-dispatcher", () => ({
  dispatchManagedResolutionCommand: mocks.resolutionDispatch,
}));
vi.mock("@/lib/solana/managed-amendment-dispatcher", () => ({ dispatchManagedAmendmentCommand: mocks.amendmentDispatch }));
vi.mock("@/lib/solana/managed-transfer-dispatcher", () => ({
  dispatchManagedFeatherTransferCommand: mocks.transferDispatch,
}));

import { GET } from "./route";

const request = new NextRequest("http://localhost/api/v1/commands/cmd_12345678");
const context = { params: Promise.resolve({ id: "cmd_12345678" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status: "FINALIZED" });
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.cancelDispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.amendmentDispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.transferDispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.marketDispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.bookDispatch.mockResolvedValue({ status: "FINALIZED" });
  mocks.resolutionDispatch.mockResolvedValue({ status: "FINALIZED" });
});

describe("GET /api/v1/commands/[id]", () => {
  it("returns only the authenticated actor's safe command status", async () => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678" } });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "cmd_12345678", status: "FINALIZED" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("does not reveal whether another user's command exists", async () => {
    mocks.load.mockResolvedValue({ identity: { actorId: "other_user" } });
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("COMMAND_NOT_FOUND");
    expect(mocks.publicStatus).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it.each(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "FAILED_RETRYABLE"])(
    "schedules fenced recovery while returning the durable %s status",
    async status => {
      mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "PLACE_ORDER" } });
      mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
      const response = await GET(request, context);
      expect(response.status).toBe(200);
      expect((await response.json()).status).toBe(status);
      expect(mocks.after).toHaveBeenCalledOnce();
      expect(mocks.dispatch).toHaveBeenCalledWith("cmd_12345678");
    },
  );

  it.each(["UNKNOWN", "FINALIZED", "FAILED_TERMINAL"])("does not automatically replace or redispatch %s", async status => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "PLACE_ORDER" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
    await GET(request, context);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.transferDispatch).not.toHaveBeenCalled();
  });

  it.each(["SIGNED", "UNKNOWN"])("reconciles retained managed transfer wire in %s through status polling", async status => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "TRANSFER_FEATHERS" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(mocks.transferDispatch).toHaveBeenCalledWith("cmd_12345678");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.cancelDispatch).not.toHaveBeenCalled();
  });

  it.each(["ACCEPTED", "PREPARED", "SIGNED", "SUBMITTED", "CONFIRMED", "UNKNOWN", "FAILED_RETRYABLE"])(
    "reconciles a durable cancellation in %s without using the placement dispatcher",
    async status => {
      mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "CANCEL_ORDER" } });
      mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
      const response = await GET(request, context);
      expect(response.status).toBe(200);
      expect(mocks.cancelDispatch).toHaveBeenCalledWith("cmd_12345678");
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.transferDispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["SIGNED", "UNKNOWN"])("reconciles an atomic managed amendment in %s", async status => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "REPLACE_ORDER" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
    await GET(request, context);
    expect(mocks.amendmentDispatch).toHaveBeenCalledWith("cmd_12345678");
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.cancelDispatch).not.toHaveBeenCalled();
  });

  it.each(["SIGNED", "UNKNOWN", "FINALIZED"])("lets only the originating active administrator reconcile market provisioning in %s", async status => {
    mocks.requireUser.mockResolvedValueOnce({ id: "admin_12345678", role: "ADMIN", status: "ACTIVE" });
    mocks.load.mockResolvedValue({ identity: { actorId: "admin_12345678", operation: "PROVISION_MARKET" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(mocks.marketDispatch).toHaveBeenCalledWith("cmd_12345678");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(["SIGNED", "UNKNOWN", "FINALIZED"])("lets only the originating active administrator reconcile order-book provisioning in %s", async status => {
    mocks.requireUser.mockResolvedValueOnce({ id: "admin_12345678", role: "ADMIN", status: "ACTIVE" });
    mocks.load.mockResolvedValue({ identity: { actorId: "admin_12345678", operation: "PROVISION_MARKET_BOOK" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(mocks.bookDispatch).toHaveBeenCalledWith("cmd_12345678");
    expect(mocks.marketDispatch).not.toHaveBeenCalled();
  });

  it("hides market-provisioning status from the originating user after administrator access is removed", async () => {
    mocks.requireUser.mockResolvedValueOnce({ id: "admin_12345678", role: "USER", status: "ACTIVE" });
    mocks.load.mockResolvedValue({ identity: { actorId: "admin_12345678", operation: "PROVISION_MARKET" } });
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect(mocks.publicStatus).not.toHaveBeenCalled();
    expect(mocks.marketDispatch).not.toHaveBeenCalled();
  });

  it.each(["CLOSE_RESOLUTION", "PROPOSE_RESOLUTION", "APPROVE_RESOLUTION", "FINALIZE_RESOLUTION"])(
    "lets only the originating administrator recover %s",
    async operation => {
      mocks.requireUser.mockResolvedValueOnce({ id: "admin_12345678", role: "ADMIN", status: "ACTIVE" });
      mocks.load.mockResolvedValue({ identity: { actorId: "admin_12345678", operation } });
      mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status: "UNKNOWN" });
      const response = await GET(request, context);
      expect(response.status).toBe(200);
      expect(mocks.resolutionDispatch).toHaveBeenCalledWith("cmd_12345678");
    },
  );

  it("lets a managed user recover only their own claim command", async () => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678", operation: "CLAIM_RESOLUTION" } });
    mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status: "UNKNOWN" });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(mocks.resolutionDispatch).toHaveBeenCalledWith("cmd_12345678");
  });
});
