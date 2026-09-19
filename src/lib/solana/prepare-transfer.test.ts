import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, blockhash, createNoopSigner, getAddressEncoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { prepareFeatherTransfer } from "./prepare-transfer";

const mocks = vi.hoisted(() => ({ read: vi.fn(), account: vi.fn(), genesis: vi.fn(), latest: vi.fn() }));
vi.mock("./configuration", () => ({ readGooseyConfiguration: mocks.read }));
vi.mock("@solana/kit", async importOriginal => ({
  ...await importOriginal<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
    getGenesisHash: () => ({ send: mocks.genesis }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }),
  }),
}));
const mint = address("EPXKTspQpNsYjw8khbTawjXeUJdVknL1iDrxVq7itvaw");
const sender = createNoopSigner(address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"));
const recipient = address("B65XrNy82H9MeHnxxBihjUnwaRM9fXiMfTsCBuw2GvDo");
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999", programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const input = () => ({ runtime, sender, recipient, displayAmount: "123.456" });
function account(change?: (data: Buffer) => void) {
  const data = Buffer.alloc(165);
  data.set(getAddressEncoder().encode(mint), 0);
  data.set(getAddressEncoder().encode(sender.address), 32);
  data.writeBigUInt64LE(1_000_000n, 64); data[108] = 1;
  change?.(data);
  return { context: { slot: 101n }, value: { owner: TOKEN_PROGRAM_ADDRESS, executable: false, data: [data.toString("base64"), "base64"] } };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue({ featherMint: mint, finalizedSlot: 100n });
  mocks.account.mockResolvedValue(account()); mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.latest.mockResolvedValue({ context: { slot: 102n }, value: { blockhash: blockhash(runtime.genesisHash), lastValidBlockHeight: 200n } });
});
describe("wallet transfer preparation (mock RPC, no chain execution claims)", () => {
  it("builds a wallet-approved two-instruction transaction with exact amount and real RPC lifetime", async () => {
    const plan = await prepareFeatherTransfer(input());
    expect(plan.amount).toBe(123456n); expect(plan.finalizedBalance).toBe(1000000n);
    expect(plan.message.instructions).toHaveLength(2);
    expect(plan.message.feePayer.address).toBe(sender.address);
    expect(plan.message.lifetimeConstraint).toEqual({ blockhash: runtime.genesisHash, lastValidBlockHeight: 200n });
    expect(mocks.account.mock.calls[0][0][1]).toMatchObject({ commitment: "finalized", minContextSlot: 100n });
    expect(mocks.latest.mock.calls[0][0][0]).toEqual({ commitment: "finalized", minContextSlot: 101n });
  });
  it.each(["0", "-1", "0.0001", "1e2"])("rejects invalid amount %s before RPC", async displayAmount => {
    await expect(prepareFeatherTransfer({ ...input(), displayAmount })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("rejects self and zero recipients before RPC", async () => {
    for (const recipient of [sender.address, address("11111111111111111111111111111111")]) {
      await expect(prepareFeatherTransfer({ ...input(), recipient })).rejects.toThrow();
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each([null, { ...account().value, executable: true }, { ...account().value, owner: mint }])("rejects unavailable/invalid source %o", async value => {
    mocks.account.mockResolvedValue({ context: { slot: 101n }, value });
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("owner");
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each([0, 32, 108])("rejects wrong mint/owner/frozen state at byte %i", async offset => {
    mocks.account.mockResolvedValue(account(data => { data[offset] ^= 3; }));
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("unfrozen");
  });
  it("rejects insufficient funds without constructing a lifetime", async () => {
    mocks.account.mockResolvedValue(account(data => data.writeBigUInt64LE(123455n, 64)));
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("Insufficient");
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects changed network before getting a signable message", async () => {
    mocks.genesis.mockResolvedValue("different");
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("genesis changed");
    expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("propagates cancellation and configuration failures without fallback balances", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareFeatherTransfer({ ...input(), signal: controller.signal })).rejects.toThrow();
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockRejectedValue(new Error("domain mismatch"));
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("domain mismatch");
    expect(mocks.account).not.toHaveBeenCalled();
  });
  it("captures runtime, amount and recipient before an asynchronous wallet change", async () => {
    const value: Parameters<typeof prepareFeatherTransfer>[0] = { ...input(), runtime: { ...runtime } };
    const pending = prepareFeatherTransfer(value);
    Object.assign(value.runtime, { genesisHash: "changed", rpcUrl: "https://untrusted.invalid" });
    value.sender = createNoopSigner(recipient); value.recipient = sender.address; value.displayAmount = "999";
    const plan = await pending;
    expect(plan).toMatchObject({ sender: sender.address, recipient, amount: 123456n, genesisHash: runtime.genesisHash });
  });
  it("rejects in-place signer identity mutation before returning a signable message", async () => {
    const mutable = { ...sender };
    mocks.latest.mockImplementation(async () => {
      Object.assign(mutable, { address: recipient });
      return { context: { slot: 102n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 200n } };
    });
    await expect(prepareFeatherTransfer({ ...input(), sender: mutable })).rejects.toThrow("Sender changed");
  });
  it.each([99n, -1n, 1n << 64n, 101])("rejects inconsistent account context %s", async slot => {
    mocks.account.mockResolvedValue({ ...account(), context: { slot } });
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("context");
  });
  it.each([72, 109, 129])("rejects unsupported token option encoding at %i", async offset => {
    mocks.account.mockResolvedValue(account(data => data.writeUInt32LE(2, offset)));
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("options");
  });
  it("rejects stale blockhash context", async () => {
    mocks.latest.mockResolvedValue({ context: { slot: 100n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 200n } });
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("context");
  });
  it.each([-1n, 1n << 64n, 200])("rejects invalid signing height %s", async lastValidBlockHeight => {
    mocks.latest.mockResolvedValue({ context: { slot: 102n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight } });
    await expect(prepareFeatherTransfer(input())).rejects.toThrow("lifetime");
  });
  it("honors cancellation even if the final RPC resolves after abort", async () => {
    const controller = new AbortController();
    mocks.latest.mockImplementation(async () => {
      controller.abort();
      return { context: { slot: 102n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 200n } };
    });
    await expect(prepareFeatherTransfer({ ...input(), signal: controller.signal })).rejects.toThrow();
  });
});
