import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const mock = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), browser: vi.fn() }));
vi.mock("@/lib/solana/configuration", () => ({ readGooseyConfiguration: mock.read }));
vi.mock("@/lib/solana/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/solana/runtime")>(), resolveSolanaRuntime: mock.resolve,
}));
vi.mock("@/lib/solana/browser-runtime", () => ({ buildPublicBrowserRuntime: mock.browser }));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "localnet"); mock.browser.mockReturnValue({ version: 1, enabled: false }); });
afterEach(() => vi.unstubAllEnvs());
describe("public Solana deployment status", () => {
  it("reports disabled without touching RPC when configuration is absent", async () => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", "");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled", financialBackend: "database", exchangeVerified: false });
    expect(mock.resolve).not.toHaveBeenCalled(); expect(mock.read).not.toHaveBeenCalled();
    expect(mock.browser).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("returns only whitelisted public fields and exact counters without asserting exchange readiness", async () => {
    mock.resolve.mockReturnValue({ cluster: "localnet", genesisHash: "genesis", programAddress: "program", rpcUrl: "https://private.example/?secret=provider-key" });
    mock.read.mockResolvedValue({ config: "config", featherMint: "mint", finalizedSlot: 9007199254740993n,
      supply: 9007199254740993n, totalMinted: 9007199254740994n, totalAuthorized: 9007199254740995n,
      campaignCap: 9007199254740996n, enrollmentAuthority: "private-issuer-detail", admin: "admin" });
    const response = await GET(), text = await response.text(), body = JSON.parse(text);
    expect(body).toMatchObject({ status: "foundation_verified", exchangeVerified: false, financialBackend: "database",
      browserRuntime: { version: 1, enabled: false },
      finalizedSlot: "9007199254740993", supplyBaseUnits: "9007199254740993", currency: { purchasable: false, cashRedeemable: false } });
    for (const secret of ["provider-key", "rpcUrl", "private-issuer-detail", "admin"]) expect(text).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("publishes only explicitly approved browser capability after foundation verification", async () => {
    mock.resolve.mockReturnValue({ rpcUrl: "https://private.example/?secret=server-key" });
    mock.browser.mockReturnValue({ version: 1, enabled: true, endpointVerified: false, publicRpcUrl: "http://127.0.0.1:18999/", cluster: "localnet",
      genesisHash: "public-genesis", programAddress: "public-program" });
    mock.read.mockResolvedValue({ config: "config", featherMint: "mint", finalizedSlot: 1n, supply: 1n,
      totalMinted: 1n, totalAuthorized: 1n, campaignCap: 1n });
    const response = await GET(), text = await response.text(), body = JSON.parse(text);
    expect(body.browserRuntime).toEqual(mock.browser.mock.results[0].value);
    expect(body.exchangeVerified).toBe(false); expect(body.financialBackend).toBe("database");
    expect(text).not.toContain("server-key"); expect(text).not.toContain("private.example");
    mock.read.mockRejectedValue(new Error("private provider failure"));
    const failed = await GET(); expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("browserRuntime");
  });
  it("fails closed when explicit public RPC settings are invalid, without disclosing them", async () => {
    mock.resolve.mockReturnValue({});
    mock.browser.mockImplementation(() => { throw new Error("public RPC contains secret-key"); });
    const response = await GET();
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("secret-key");
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("roundtrips the real browser contract without copying the server endpoint", async () => {
    const browser = await vi.importActual<typeof import("@/lib/solana/browser-runtime")>("@/lib/solana/browser-runtime");
    const runtime = { cluster: "localnet" as const, genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
      programAddress: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q", rpcUrl: "http://127.0.0.1:19999/private-provider-token" };
    vi.stubEnv("GOOSEY_SOLANA_BROWSER_ENABLED", "true");
    vi.stubEnv("GOOSEY_SOLANA_PUBLIC_RPC_URL", "http://127.0.0.1:18999/");
    mock.resolve.mockReturnValue(runtime);
    mock.browser.mockImplementation(browser.buildPublicBrowserRuntime);
    mock.read.mockResolvedValue({ config: runtime.programAddress, featherMint: runtime.programAddress,
      finalizedSlot: 1n, supply: 1n, totalMinted: 1n, totalAuthorized: 1n, campaignCap: 1n });
    const response = await GET(), body = await response.json();
    const parsed = browser.parsePublicBrowserRuntime(body);
    expect(parsed).toEqual({ ...runtime, rpcUrl: "http://127.0.0.1:18999/" });
    expect(JSON.stringify(body)).not.toContain("private-provider-token");
    expect(body.browserRuntime.endpointVerified).toBe(false);
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
