import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/lib/solana/release-readiness", () => ({ inspectSolanaReleaseReadiness: mocks.inspect }));
vi.mock("../src/lib/solana/release-readiness-boundaries", () => ({ defaultReleaseReadinessDependencies: {} }));
vi.mock("../src/lib/solana/runtime", () => ({ resolveSolanaRuntime: mocks.resolve }));

import { runSolanaReleaseReadinessCommand } from "./solana-release-readiness";

describe("Solana release readiness command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockReturnValue({ cluster: "localnet", rpcUrl: "http://127.0.0.1:8899/?token=secret",
      genesisHash: "genesis", programAddress: "program" });
  });

  it("returns zero only for a fully ready report", async () => {
    mocks.inspect.mockResolvedValue({ ready: true, state: "ready" });
    let output = "";
    expect(await runSolanaReleaseReadinessCommand({ argv: [], env: {}, writeOut: text => { output += text; } })).toBe(0);
    expect(JSON.parse(output)).toEqual({ ready: true, state: "ready" });
  });

  it("returns nonzero for a valid non-ready report", async () => {
    mocks.inspect.mockResolvedValue({ ready: false, state: "partial" });
    let output = "";
    expect(await runSolanaReleaseReadinessCommand({ argv: [], env: {}, writeOut: text => { output += text; } })).toBe(1);
    expect(JSON.parse(output)).toEqual({ ready: false, state: "partial" });
  });

  it("never prints secrets from rejected runtime or boundary errors", async () => {
    for (const failure of [new Error("https://rpc.invalid/?api-key=secret"), new Error("postgres://user:password@host")]) {
      mocks.resolve.mockImplementationOnce(() => { throw failure; });
      let stdout = "", stderr = "";
      expect(await runSolanaReleaseReadinessCommand({ argv: [], env: {},
        writeOut: text => { stdout += text; }, writeErr: text => { stderr += text; } })).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).not.toMatch(/secret|password|rpc\.invalid|postgres/);
      expect(stderr).toContain("No transaction was signed or submitted");
    }
  });

  it("supports help without reading runtime or external boundaries", async () => {
    let output = "";
    expect(await runSolanaReleaseReadinessCommand({ argv: ["--help"], env: {},
      writeOut: text => { output += text; } })).toBe(0);
    expect(output).toContain("Reads only");
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("fails closed on unknown arguments", async () => {
    let stderr = "";
    expect(await runSolanaReleaseReadinessCommand({ argv: ["--rpc", "https://evil.invalid"], env: {},
      writeErr: text => { stderr += text; } })).toBe(1);
    expect(stderr).not.toContain("evil.invalid");
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
