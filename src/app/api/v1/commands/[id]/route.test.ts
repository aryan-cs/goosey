import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUser: vi.fn(), load: vi.fn(), publicStatus: vi.fn() }));
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

import { GET } from "./route";

const request = new NextRequest("http://localhost/api/v1/commands/cmd_12345678");
const context = { params: Promise.resolve({ id: "cmd_12345678" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "user_12345678" });
  mocks.publicStatus.mockResolvedValue({ id: "cmd_12345678", status: "FINALIZED" });
});

describe("GET /api/v1/commands/[id]", () => {
  it("returns only the authenticated actor's safe command status", async () => {
    mocks.load.mockResolvedValue({ identity: { actorId: "user_12345678" } });
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "cmd_12345678", status: "FINALIZED" });
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("does not reveal whether another user's command exists", async () => {
    mocks.load.mockResolvedValue({ identity: { actorId: "other_user" } });
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("COMMAND_NOT_FOUND");
    expect(mocks.publicStatus).not.toHaveBeenCalled();
  });
});
