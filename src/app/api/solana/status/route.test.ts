import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mock = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/solana/configuration", () => ({ readGooseyConfiguration: mock.read }));
vi.mock("@/lib/solana/runtime", () => ({ resolveSolanaRuntime: mock.resolve }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet"); });
afterEach(() => vi.unstubAllEnvs());
describe("public Solana deployment status", () => {
  it("reports disabled without touching RPC when configuration is absent", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled", financialBackend: "database", exchangeVerified: false });
    expect(mock.resolve).not.toHaveBeenCalled(); expect(mock.read).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns only whitelisted public fields and exact counters without asserting exchange readiness", async () => {
    mock.resolve.mockReturnValue({ cluster: "localnet", genesisHash: "genesis", programAddress: "program", rpcUrl: "https://private.example/?secret=provider-key" });
    mock.read.mockResolvedValue({ config: "config", featherMint: "mint", finalizedSlot: 9007199254740993n,
      supply: 9007199254740993n, totalMinted: 9007199254740994n, totalAuthorized: 9007199254740995n,
      campaignCap: 9007199254740996n, enrollmentAuthority: "private-issuer-detail", admin: "admin" });
    const response = await GET(), text = await response.text(), body = JSON.parse(text);
    expect(body).toMatchObject({ status: "foundation_verified", exchangeVerified: false, financialBackend: "database",
      finalizedSlot: "9007199254740993", supplyBaseUnits: "9007199254740993", currency: { purchasable: false, cashRedeemable: false } });
    for (const secret of ["provider-key", "rpcUrl", "private-issuer-detail", "admin"]) expect(text).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["config", "rpc"])("fails closed without leaking %s errors", async source => {
    const error = new Error("private RPC secret=provider-key");
    if (source === "config") mock.resolve.mockImplementation(() => { throw error; });
    else { mock.resolve.mockReturnValue({}); mock.read.mockRejectedValue(error); }
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("provider-key");
  });
});
