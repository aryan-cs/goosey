import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(), load: vi.fn(), publicStatus: vi.fn(), after: vi.fn(), dispatch: vi.fn(),
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

import { GET } from "./route";

const request = new NextRequest("http://localhost/api/v1/commands/cmd_12345678");
const context = { params: Promise.resolve({ id: "cmd_12345678" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status: "FINALIZED" });
  mocks.after.mockImplementation((callback: () => unknown) => callback());
  mocks.dispatch.mockResolvedValue({ status: "FINALIZED" });
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
  });
});
