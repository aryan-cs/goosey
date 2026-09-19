import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { readGooseyWalletBalance } from "./wallet-balance";

const mocks = vi.hoisted(() => ({ configuration: vi.fn(), batch: vi.fn(), genesis: vi.fn(), rpc: vi.fn() }));
vi.mock("./configuration", () => ({ readGooseyConfiguration: mocks.configuration }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: (url: string) => {
    mocks.rpc(url);
    return { getMultipleAccounts: (...args: unknown[]) => ({ send: (options: unknown) => mocks.batch(args, options) }),
      getGenesisHash: () => ({ send: mocks.genesis }) };
  },
}));
const mint = address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw");
const wallet = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"),
  genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const input = () => ({ runtime: { ...runtime }, wallet: wallet as Address });
function token(change?: (bytes: Buffer) => void) {
  const bytes = Buffer.alloc(165);
  bytes.set(getAddressEncoder().encode(mint)); bytes.set(getAddressEncoder().encode(wallet), 32);
  bytes.writeBigUInt64LE(9007199254740993n, 64); bytes[108] = 1; change?.(bytes);
  return { owner: TOKEN_PROGRAM_ADDRESS as string, executable: false, lamports: 2039280n,
    data: [bytes.toString("base64"), "base64"] };
}
function systemWallet() {
  return { owner: SYSTEM_PROGRAM_ADDRESS as string, executable: false, lamports: 9007199254740995n, data: ["", "base64"] };
}
function snapshot() {
  return { context: { slot: 101n }, value: [systemWallet(), token()] as (ReturnType<typeof token> | null)[] };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.configuration.mockResolvedValue({ featherMint: mint, finalizedSlot: 100n, supply: 1n });
  mocks.batch.mockResolvedValue(snapshot()); mocks.genesis.mockResolvedValue(runtime.genesisHash);
});

describe("finalized wallet balance reader (mocked RPC, not chain execution proof)", () => {
  it("reads canonical wallet+ATA in one finalized batch with exact bigint balances", async () => {
    const result = await readGooseyWalletBalance(input());
    const [walletTokens] = await findAssociatedTokenPda({ mint, owner: wallet, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(result).toMatchObject({ wallet, mint, walletTokens, featherAmount: 9007199254740993n,
      solLamports: 9007199254740995n, featherDecimals: 3, observedSlot: 101n, configurationSlot: 100n,
      featherAccountStatus: "present", walletAccountStatus: "present", walletAccountOwner: SYSTEM_PROGRAM_ADDRESS,
      ordinaryFeePayerAccount: true, genesisHash: runtime.genesisHash });
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0][0]).toEqual([[wallet, walletTokens], {
      commitment: "finalized", encoding: "base64", minContextSlot: 100n }]);
    expect(mocks.genesis).toHaveBeenCalledTimes(1);
  });

  it.each(["ata", "wallet", "both"])("returns explicit absence for missing %s only", async missing => {
    const value = snapshot();
    if (missing !== "ata") value.value[0] = null;
    if (missing !== "wallet") value.value[1] = null;
    mocks.batch.mockResolvedValue(value);
    const result = await readGooseyWalletBalance(input());
    expect(result.featherAccountStatus).toBe(missing === "wallet" ? "present" : "absent");
    expect(result.featherAmount).toBe(missing === "wallet" ? 9007199254740993n : 0n);
    expect(result.walletAccountStatus).toBe(missing === "ata" ? "present" : "absent");
    expect(result.solLamports).toBe(missing === "ata" ? 9007199254740995n : 0n);
    expect(result.ordinaryFeePayerAccount).toBe(missing === "ata");
  });

  it("distinguishes existing zero accounts from absence", async () => {
    const value = snapshot(); value.value[0]!.lamports = 0n; value.value[1] = token(bytes => bytes.writeBigUInt64LE(0n, 64));
    mocks.batch.mockResolvedValue(value);
    expect(await readGooseyWalletBalance(input())).toMatchObject({ solLamports: 0n, featherAmount: 0n,
      walletAccountStatus: "present", featherAccountStatus: "present" });
  });

  it("preserves the entire unsigned 64-bit balance range", async () => {
    const maximum = (1n << 64n) - 1n, value = snapshot();
    value.value[0]!.lamports = maximum;
    value.value[1] = token(bytes => bytes.writeBigUInt64LE(maximum, 64));
    mocks.batch.mockResolvedValue(value);
    expect(await readGooseyWalletBalance(input())).toMatchObject({ solLamports: maximum, featherAmount: maximum });
  });

  it.each(["owner", "encoding", "executable-type"])("rejects malformed wallet envelope %s", async change => {
    const value = snapshot(), account = value.value[0]!;
    if (change === "owner") account.owner = "invalid";
    if (change === "encoding") account.data[1] = "base58";
    mocks.batch.mockResolvedValue(change === "executable-type"
      ? { ...value, value: [{ ...account, executable: "false" }, value.value[1]] } : value);
    await expect(readGooseyWalletBalance(input())).rejects.toThrow();
  });

  it.each(["owner", "executable", "data"])("does not advertise nonordinary wallet %s as fee funding", async change => {
    const value = snapshot(), account = value.value[0]!;
    if (change === "owner") account.owner = runtime.programAddress;
    if (change === "executable") account.executable = true;
    if (change === "data") account.data[0] = "AA==";
    mocks.batch.mockResolvedValue(value);
    expect(await readGooseyWalletBalance(input())).toMatchObject({ solLamports: 9007199254740995n,
      walletAccountStatus: "present", ordinaryFeePayerAccount: false });
  });

  it.each(["owner", "executable", "encoding", "length", "noncanonical"])("rejects malformed ATA %s", async change => {
    const value = snapshot(), account = value.value[1]!;
    if (change === "owner") account.owner = SYSTEM_PROGRAM_ADDRESS;
    if (change === "executable") account.executable = true;
    if (change === "encoding") account.data[1] = "base58";
    if (change === "length") account.data[0] += "AAAA";
    if (change === "noncanonical") account.data[0] = "!".repeat(220);
    mocks.batch.mockResolvedValue(value);
    await expect(readGooseyWalletBalance(input())).rejects.toThrow();
  });

  it.each(["mint", "wallet", "frozen", "uninitialized", "delegate-option", "native-option", "close-option"])("rejects invalid token %s", async change => {
    const value = snapshot(); value.value[1] = token(bytes => {
      if (change === "mint") bytes.set(getAddressEncoder().encode(wallet), 0);
      if (change === "wallet") bytes.set(getAddressEncoder().encode(mint), 32);
      if (change === "frozen") bytes[108] = 2;
      if (change === "uninitialized") bytes[108] = 0;
      if (change === "delegate-option") bytes.writeUInt32LE(2, 72);
      if (change === "native-option") bytes.writeUInt32LE(1, 109);
      if (change === "close-option") bytes.writeUInt32LE(2, 129);
    }); mocks.batch.mockResolvedValue(value);
    await expect(readGooseyWalletBalance(input())).rejects.toThrow();
  });

  it("permits valid delegate/close authority metadata without claiming spendability", async () => {
    const value = snapshot(); value.value[1] = token(bytes => {
      bytes.writeUInt32LE(1, 72); bytes.set(getAddressEncoder().encode(mint), 76);
      bytes.writeBigUInt64LE(12n, 121); bytes.writeUInt32LE(1, 129); bytes.set(getAddressEncoder().encode(mint), 133);
    }); mocks.batch.mockResolvedValue(value);
    expect((await readGooseyWalletBalance(input())).featherAmount).toBe(9007199254740993n);
  });

  it.each([-1n, 1n << 64n, 1])("rejects invalid lamports %s", async lamports => {
    const value = snapshot(); mocks.batch.mockResolvedValue({ ...value, value: [{ ...value.value[0], lamports }, value.value[1]] });
    await expect(readGooseyWalletBalance(input())).rejects.toThrow("lamports");
  });

  it.each([99n, -1n, 1n << 64n, 101])("rejects invalid or stale snapshot slot %s", async slot => {
    mocks.batch.mockResolvedValue({ ...snapshot(), context: { slot } });
    await expect(readGooseyWalletBalance(input())).rejects.toThrow();
  });

  it.each([-1n, 1n << 64n, 100])("rejects invalid configuration slot %s", async finalizedSlot => {
    mocks.configuration.mockResolvedValue({ featherMint: mint, finalizedSlot });
    await expect(readGooseyWalletBalance(input())).rejects.toThrow("configuration slot");
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it.each([{ value: [] }, { value: [null] }, { value: [null, null, null] }])("rejects incorrect batch arity %o", async ({ value }) => {
    mocks.batch.mockResolvedValue({ ...snapshot(), value });
    await expect(readGooseyWalletBalance(input())).rejects.toThrow("snapshot");
  });

  it.each(["configuration", "batch", "genesis"] as const)("propagates %s RPC errors, never substitutes zero", async stage => {
    mocks[stage].mockRejectedValue(new Error("RPC unavailable"));
    await expect(readGooseyWalletBalance(input())).rejects.toThrow("RPC unavailable");
  });

  it("rejects a changed network even when both accounts are absent", async () => {
    mocks.batch.mockResolvedValue({ context: { slot: 101n }, value: [null, null] });
    mocks.genesis.mockResolvedValue(wallet);
    await expect(readGooseyWalletBalance(input())).rejects.toThrow("genesis changed");
  });

  it("rejects unpinned runtime and invalid wallet before reads", async () => {
    await expect(readGooseyWalletBalance({ ...input(), runtime: { ...runtime, rpcUrl: "https://not-local.example" } })).rejects.toThrow();
    await expect(readGooseyWalletBalance({ ...input(), wallet: "invalid" as typeof wallet })).rejects.toThrow();
    expect(mocks.configuration).not.toHaveBeenCalled();
  });

  it("honors abort before work and after the final network recheck", async () => {
    const early = new AbortController(); early.abort();
    await expect(readGooseyWalletBalance({ ...input(), signal: early.signal })).rejects.toThrow();
    expect(mocks.configuration).not.toHaveBeenCalled();
    const late = new AbortController(); mocks.genesis.mockImplementation(async () => { late.abort(); return runtime.genesisHash; });
    await expect(readGooseyWalletBalance({ ...input(), signal: late.signal })).rejects.toThrow();
    expect(mocks.batch.mock.calls[0][1]).toEqual({ abortSignal: late.signal });
  });

  it("captures wallet and runtime before the first await", async () => {
    const value = input(); const pending = readGooseyWalletBalance(value);
    value.wallet = mint; value.runtime.rpcUrl = "https://changed.example";
    value.runtime.genesisHash = wallet;
    expect(await pending).toMatchObject({ wallet, genesisHash: runtime.genesisHash });
    expect(mocks.rpc).toHaveBeenCalledWith(runtime.rpcUrl + "/");
  });
});
