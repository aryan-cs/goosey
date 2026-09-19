import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRegisterMarketArguments, runRegisterMarketCli } from "./solana-register-market";

// CLI orchestration tests only: service/startup are mocked, no database or RPC.
// Real SQLite catalog transactions have a separate integration suite.
const mocks = vi.hoisted(() => ({ startup: vi.fn(), disconnect: vi.fn(), register: vi.fn() }));
vi.mock("../src/lib/db", () => ({ db: { $disconnect: mocks.disconnect }, requireDatabaseStartup: mocks.startup }));
vi.mock("../src/lib/solana/market-catalog", () => ({ registerSolanaMarket: mocks.register }));
const args = () => ["--actor-user-id", "unit_admin", "--chain-market-id", "7", "--slug", "unit-catalog",
  "--short-title", "Unit CLI fixture", "--description", "Mocked CLI fixture description only.", "--category", "Tests"];
const env = { GOOSEY_SOLANA_CLUSTER: "localnet", GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:1/?token=private-provider-token",
  GOOSEY_SOLANA_PROGRAM_ID: "CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q",
  GOOSEY_SOLANA_GENESIS_HASH: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm",
  GOOSEY_SOLANA_TERMS_DIRECTORY: "/mocked-private-terms", DATABASE_PROVIDER: "sqlite", DATABASE_URL: "file:/never-opened-cli-test.db" };
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("POSTGRES_DATABASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.startup.mockResolvedValue(undefined); mocks.disconnect.mockResolvedValue(undefined);
  mocks.register.mockResolvedValue({ created: true, market: { id: "unit_market", status: "DRAFT", executionBackend: "SOLANA" },
    binding: { chainMarketId: "7" }, privateIgnoredField: "must-not-print" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("operator catalog CLI (mocked service boundary)", () => {
  it.each(["0", "7", "18446744073709551615"])("parses canonical u64 %s without number rounding", id => {
    const input = args(); input[3] = id;
    expect(parseRegisterMarketArguments(input).chainMarketId).toBe(BigInt(id));
  });
  it.each(["-1", "+1", "01", "1.0", "1e3", " 1", "18446744073709551616", "9".repeat(100)])("rejects invalid u64 %s", id => {
    const input = args(); input[3] = id; expect(() => parseRegisterMarketArguments(input)).toThrow();
  });
  it.each(["missing", "duplicate", "unknown", "equals", "positional", "blank", "flag-value", "actor", "slug", "short", "description", "category", "control", "trim"])("rejects %s without loading startup or service", async change => {
    const input = args();
    if (change === "missing") input.pop();
    if (change === "duplicate") input[10] = "--slug";
    if (change === "unknown") input[0] = "--rpc-url";
    if (change === "equals") input[0] = "--actor-user-id=unit_admin";
    if (change === "positional") input.push("register");
    if (change === "blank") input[1] = "";
    if (change === "flag-value") input[1] = "--help";
    if (change === "actor") input[1] = "bad actor";
    if (change === "slug") input[5] = "UPPER_CASE";
    if (change === "short") input[7] = "x".repeat(91);
    if (change === "description") input[9] = "short";
    if (change === "category") input[11] = "x";
    if (change === "control") input[9] += "\u0000";
    if (change === "trim") input[9] += " ";
    expect(await runRegisterMarketCli(input)).toBe(1);
    expect(mocks.startup).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"code":"ARGUMENTS"'));
  });
  it.each(["--help", "-h"])("%s needs no runtime or DB", async option => {
    vi.stubEnv("GOOSEY_SOLANA_CLUSTER", ""); vi.stubEnv("DATABASE_URL", "");
    expect(await runRegisterMarketCli([option])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("DRAFT/SOLANA"));
    expect(mocks.startup).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it.each(Object.keys(env))("requires valid server setting %s before startup", async key => {
    // DATABASE_PROVIDER defaults to sqlite outside production; make invalid rather than absent.
    vi.stubEnv(key, key === "DATABASE_PROVIDER" ? "invalid" : "");
    expect(await runRegisterMarketCli(args())).toBe(1);
    expect(mocks.startup).not.toHaveBeenCalled(); expect(mocks.register).not.toHaveBeenCalled();
  });
  it.each(["relative", "/", "/terms/../private", "/private\nterms"])("rejects unsafe terms-directory syntax %s", async directory => {
    vi.stubEnv("GOOSEY_SOLANA_TERMS_DIRECTORY", directory);
    expect(await runRegisterMarketCli(args())).toBe(1); expect(mocks.startup).not.toHaveBeenCalled();
  });
  it("calls guarded shipping service with exact metadata and trusted runtime, then disconnects", async () => {
    expect(await runRegisterMarketCli(args())).toBe(0);
    expect(mocks.startup).toHaveBeenCalledOnce(); expect(mocks.register).toHaveBeenCalledExactlyOnceWith({
      ...parseRegisterMarketArguments(args()), termsDirectory: env.GOOSEY_SOLANA_TERMS_DIRECTORY,
      runtime: { cluster: "localnet", rpcUrl: env.GOOSEY_SOLANA_RPC_URL, programAddress: env.GOOSEY_SOLANA_PROGRAM_ID,
        genesisHash: env.GOOSEY_SOLANA_GENESIS_HASH } });
    expect(mocks.startup.mock.invocationCallOrder[0]).toBeLessThan(mocks.register.mock.invocationCallOrder[0]);
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "solana_market_registered", created: true,
      marketId: "unit_market", chainMarketId: "7", status: "DRAFT", executionBackend: "SOLANA" }));
  });
  it("reports idempotency and actual existing status without claiming it demoted a listing", async () => {
    mocks.register.mockResolvedValue({ created: false, market: { id: "unit_market", status: "OPEN", executionBackend: "SOLANA" }, binding: { chainMarketId: "7" } });
    expect(await runRegisterMarketCli(args())).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"created":false'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"status":"OPEN"'));
  });
  it("startup rejection never calls registration and still disconnects", async () => {
    mocks.startup.mockRejectedValue(new Error("secret database connection string"));
    expect(await runRegisterMarketCli(args())).toBe(1); expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"code":"DATABASE_STARTUP"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
  it.each(["ADMIN_REQUIRED", "CHAIN_MARKET_NOT_PUBLISHED", "CHAIN_CATALOG_CONFLICT", "private-provider-token"])("sanitizes service failure %s without retry", async code => {
    mocks.register.mockRejectedValue(Object.assign(new Error("secret SQL, RPC URL and token"), { code }));
    expect(await runRegisterMarketCli(args())).toBe(1); expect(mocks.register).toHaveBeenCalledOnce(); expect(mocks.disconnect).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
    const output = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).not.toContain("secret"); expect(output).not.toContain("private-provider-token");
    expect(output).toContain(code === "private-provider-token" ? "REGISTRATION" : code);
  });
  it("reports cleanup uncertainty without retrying successful registration", async () => {
    mocks.disconnect.mockRejectedValue(new Error("private path"));
    expect(await runRegisterMarketCli(args())).toBe(1); expect(mocks.register).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("DATABASE_DISCONNECT"));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private path");
  });
  it("real entrypoint --help works with no DB/runtime environment and no service mocks", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "scripts/solana-register-market.ts", "--help"], {
      env: { PATH: process.env.PATH, NODE_ENV: "test" }, encoding: "utf8", timeout: 15_000,
    });
    expect(output).toContain("DRAFT/SOLANA");
  });
});
