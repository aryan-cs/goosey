import { address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";

import { inspectSolanaReleaseReadiness, type ReleaseReadinessDependencies } from "./release-readiness";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH, type SolanaRuntime } from "./runtime";

const program = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const config = address("8iPp7mYSWz7CrTsvom9GFp4CnbBHNZLmPSE5NrgzTq2h");
const mint = address("7XS8FEdU4kKsCrr5zV6EqP11TrzwjfPjgQURaQZDsUkM");
const mintAuthority = address("3C3t8DPrhYQoEUcE6d4F6GGCXX4sqzgMdJvxG2qUiQ5D");
const admin = address("3W5rBVFGVPCQwK6SpAf4YdnU2dny3gMTuysSy5zy4s8Z");
const enrollmentAuthority = address("HFLkZsyc7vaNXL7qEXGNeab7rE9hPGuoQRMENNgkq1um");
const marketAddress = address("C5T7M7M6oWPjvA8gJw2CbMyXrksPNikEGzHFDTU7ziUe");
const reviewer = address("BvDS7qmVnxKCJGyy9kiRaZRdKYV96GbYfQY7Y2Q1QypQ");
const reviewerEnrollment = address("FzVUWT9AUSGhc6jVoA8yYnTYp3PpH7mYtRtM3SyASAgp");
const approver = address("2b2iy5tL3fgbE9BtBZHYvk7kFMhpsKzSK3nABbUcMbdw");
const approverEnrollment = address("6nFB5uDDZNVMvdqPzBWwE3P4xG5uPpf8wSHrL5VRVhCP");
const digest = "ab".repeat(32);
const runtime: SolanaRuntime = { cluster: "devnet", rpcUrl: "https://rpc.example.invalid/?api-key=never-print",
  genesisHash: DEVNET_GENESIS_HASH, programAddress: program };

function dependencies(): ReleaseReadinessDependencies {
  return {
    probe: vi.fn().mockResolvedValue({ finalizedSlot: "100", programExecutable: true }),
    configuration: vi.fn().mockResolvedValue({ config, featherMint: mint, mintAuthority, admin,
      enrollmentAuthority, decimals: 3, finalizedSlot: "101" }),
    catalog: vi.fn().mockResolvedValue([{ marketId: "7", marketAddress }]),
    market: vi.fn().mockResolvedValue({ market: marketAddress, config, featherMint: mint, creator: admin,
      payoutMilli: "1000", feeBps: "25", closesAt: "2000000000", resolvesAt: "2000000100",
      finalizedSlot: "102", terms: { digest, manifestLength: 400, sealed: true, acceptanceBits: 3,
        proposer: { wallet: reviewer, enrollment: reviewerEnrollment },
        approver: { wallet: approver, enrollment: approverEnrollment } },
      hasOrderBook: true, hasResolution: true }),
    retainedTerms: vi.fn().mockResolvedValue({ digest }),
    indexer: vi.fn().mockResolvedValue({ worker: { state: "running" },
      coverage: { status: "bounded_complete", revision: 4, fullHistory: false } }),
  };
}

const inspect = (deps = dependencies(), overrides: Partial<Parameters<typeof inspectSolanaReleaseReadiness>[0]> = {}) =>
  inspectSolanaReleaseReadiness({ runtime, termsDirectory: "/private/terms", catalogEnabled: true,
    now: new Date("2026-09-19T12:00:00.000Z"), ...overrides }, deps);

describe("Solana release readiness", () => {
  it("returns ready only after every read-only gate and a closing deployment probe pass", async () => {
    const deps = dependencies();
    const result = await inspect(deps);
    expect(result).toMatchObject({ version: 1, state: "ready", ready: true, readOnly: true,
      deployment: { state: "ready", executable: true, cluster: "devnet", genesisHash: DEVNET_GENESIS_HASH },
      configuration: { state: "ready", decimals: 3, mintAuthority },
      markets: { state: "ready", requested: 1, ready: 1 },
      indexer: { state: "ready", worker: "running", coverage: "bounded_complete", fullHistory: false } });
    expect(deps.probe).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("api-key");
    expect(JSON.stringify(result)).not.toContain("rpc.example.invalid");
  });

  it.each([
    [new Error("Configured Goosey program is not deployed and executable."), "absent", "program_absent"],
    [new Error("Solana RPC genesis mismatch; refusing this network."), "partial", "deployment_mismatch"],
    [new Error("provider failed https://secret.invalid/?token=hunter2"), "unavailable", "rpc_unavailable"],
  ])("classifies the initial deployment boundary without relaying error details", async (failure, state, reason) => {
    const deps = dependencies();
    vi.mocked(deps.probe).mockRejectedValueOnce(failure);
    const result = await inspect(deps);
    expect(result.deployment).toMatchObject({ state, reason });
    expect(result.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(deps.configuration).not.toHaveBeenCalled();
  });

  it("fails the configuration authority/decimals gate closed", async () => {
    const deps = dependencies();
    vi.mocked(deps.configuration).mockRejectedValue(new Error("wrong mint authority"));
    const result = await inspect(deps);
    expect(result.configuration).toEqual({ state: "partial", reason: "configuration_verification_failed",
      config: null, featherMint: null, mintAuthority: null, admin: null, enrollmentAuthority: null,
      decimals: null, finalizedSlot: null });
    expect(result.state).toBe("partial");
  });

  it("distinguishes an absent published catalog from an unavailable catalog", async () => {
    const absent = dependencies();
    vi.mocked(absent.catalog).mockResolvedValue([]);
    expect((await inspect(absent)).markets).toMatchObject({ state: "absent", reason: "no_published_markets" });
    const unavailable = dependencies();
    vi.mocked(unavailable.catalog).mockRejectedValue(new Error("postgresql://secret"));
    const report = await inspect(unavailable);
    expect(report.markets).toMatchObject({ state: "unavailable", reason: "catalog_unavailable" });
    expect(JSON.stringify(report)).not.toContain("postgresql");
  });

  it("requires the catalog release switch even when its retained market verifies", async () => {
    const result = await inspect(dependencies(), { catalogEnabled: false });
    expect(result.markets).toMatchObject({ state: "partial", reason: "catalog_disabled", requested: 1, ready: 1 });
    expect(result.ready).toBe(false);
  });

  it("distinguishes missing, unavailable, and incomplete retained market evidence", async () => {
    const noDirectory = await inspect(dependencies(), { termsDirectory: undefined });
    expect(noDirectory.markets.items[0]).toMatchObject({ state: "absent", reason: "retained_terms_directory_absent" });

    const missing = dependencies();
    const absentError = Object.assign(new Error("private/path"), { code: "ENOENT" });
    vi.mocked(missing.retainedTerms).mockRejectedValue(absentError);
    expect((await inspect(missing)).markets.items[0]).toMatchObject({ state: "absent", reason: "retained_terms_absent" });

    const unavailable = dependencies();
    vi.mocked(unavailable.retainedTerms).mockRejectedValue(new Error("filesystem private/path"));
    const unavailableReport = await inspect(unavailable);
    expect(unavailableReport.markets.items[0]).toMatchObject({ state: "unavailable", reason: "retained_terms_unavailable" });
    expect(JSON.stringify(unavailableReport)).not.toContain("private/path");

    const incomplete = dependencies();
    vi.mocked(incomplete.market).mockResolvedValue({ ...await incomplete.market(runtime, 7n, AbortSignal.timeout(1_000)),
      terms: null });
    expect((await inspect(incomplete)).markets.items[0]).toMatchObject({ state: "partial", reason: "chain_binding_or_terms_incomplete" });
    expect(incomplete.retainedTerms).not.toHaveBeenCalled();
  });

  it.each([
    [{ worker: { state: "missing" }, coverage: { status: "unavailable", revision: null, fullHistory: false } }, "absent", "indexer_absent"],
    [{ worker: { state: "running" }, coverage: { status: "partial", revision: 2, fullHistory: false } }, "partial", "indexer_incomplete"],
    [{ worker: { state: "stale" }, coverage: { status: "bounded_complete", revision: 2, fullHistory: false } }, "partial", "indexer_incomplete"],
  ] as const)("classifies indexer worker and bounded coverage independently", async (value, state, reason) => {
    const deps = dependencies();
    vi.mocked(deps.indexer).mockResolvedValue(value);
    expect((await inspect(deps)).indexer).toMatchObject({ state, reason });
  });

  it("reports an unavailable indexer boundary without leaking its error", async () => {
    const deps = dependencies();
    vi.mocked(deps.indexer).mockRejectedValue(new Error("postgres://user:password@host"));
    const result = await inspect(deps);
    expect(result.indexer).toMatchObject({ state: "unavailable", reason: "indexer_status_unavailable" });
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("fails when the closing finalized deployment observation regresses", async () => {
    const deps = dependencies();
    vi.mocked(deps.probe).mockResolvedValueOnce({ finalizedSlot: "100", programExecutable: true })
      .mockResolvedValueOnce({ finalizedSlot: "99", programExecutable: true });
    const result = await inspect(deps);
    expect(result.deployment).toMatchObject({ state: "partial", reason: "deployment_changed_during_check" });
    expect(result.ready).toBe(false);
  });

  it("rejects mainnet and a devnet genesis disguised as localnet before any boundary call", async () => {
    for (const rejected of [
      { ...runtime, cluster: "localnet" as const, genesisHash: MAINNET_GENESIS_HASH, rpcUrl: "http://127.0.0.1:8899" },
      { ...runtime, cluster: "localnet" as const, genesisHash: TESTNET_GENESIS_HASH, rpcUrl: "http://127.0.0.1:8899" },
      { ...runtime, cluster: "localnet" as const, genesisHash: DEVNET_GENESIS_HASH, rpcUrl: "http://127.0.0.1:8899" },
    ]) {
      const deps = dependencies();
      await expect(inspectSolanaReleaseReadiness({ runtime: rejected, termsDirectory: "/private/terms",
        catalogEnabled: true }, deps)).rejects.toThrow("does not identify");
      expect(deps.probe).not.toHaveBeenCalled();
    }
  });
});
