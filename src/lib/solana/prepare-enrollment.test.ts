import { createHash } from "node:crypto";
import { address, getAddressEncoder, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeEnrollmentInstruction, deriveGooseyEnrollmentAddresses } from "./program-client";
import { prepareEnrollment } from "./prepare-enrollment";

const mocks = vi.hoisted(() => ({ genesis: vi.fn(), account: vi.fn(), batch: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
    getMultipleAccounts: (...args: unknown[]) => ({ send: (options: unknown) => mocks.batch(args, options) }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const issuer = address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W");
const wallet = address("B65XrNy82H9MeHnxxBihjUnwaRM9fXiMfTsCBuw2GvDo");
const clockAddress = address("SysvarC1ock11111111111111111111111111111111"), sysvar = address("Sysvar1111111111111111111111111111111111111");
const hash = (text: string) => createHash("sha256").update(text).digest();
const encode = getAddressEncoder();
const input = () => ({ runtime: { ...runtime }, enrollmentAuthority: { address: issuer as Address, signTransactions: mocks.sign },
  wallet: wallet as Address, identityDigest: new Uint8Array(hash("explicit operator identity fixture")), allowance: 1000n, expiresAt: 200n });
const account = (data: Buffer, owner: Address = runtime.programAddress) => ({ owner, executable: false, data: [data.toString("base64"), "base64"] as const });
const lifetime = () => ({ context: { slot: 504n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } });

// Mocked RPC codec fixtures only; no on-chain execution, funding or DB mutations.
async function fixture() {
  const a = await deriveGooseyEnrollmentAddresses({ programAddress: runtime.programAddress, wallet, identityDigest: input().identityDigest });
  const config = Buffer.alloc(172), mint = Buffer.alloc(82), clock = Buffer.alloc(40);
  config.set(hash("account:Config").subarray(0, 8)); config.set([1, 1, a.configBump, a.mintAuthorityBump], 8);
  config.set(hash(runtime.genesisHash), 12); config.set(encode.encode(wallet), 44); config.set(encode.encode(issuer), 76);
  config.set(encode.encode(a.featherMint), 108);
  config.writeBigUInt64LE(1000n, 140); config.writeBigUInt64LE(5000n, 148); config.writeBigUInt64LE(2000n, 156); config.writeBigUInt64LE(1000n, 164);
  mint.writeUInt32LE(1, 0); mint.set(encode.encode(a.mintAuthority), 4); mint.writeBigUInt64LE(1000n, 36); mint[44] = 3; mint[45] = 1;
  clock.writeBigUInt64LE(503n, 0); clock.writeBigInt64LE(100n, 32);
  return { a, config, mint, clock, batch: () => ({ context: { slot: 503n }, value: [account(config), account(mint, TOKEN_PROGRAM_ADDRESS),
    null, null, account(clock, sysvar)] as (ReturnType<typeof account> | null)[] }) };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  vi.resetAllMocks(); f = await fixture();
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.account.mockResolvedValue({ context: { slot: 500n }, value: { executable: true, owner: address("BPFLoaderUpgradeab1e11111111111111111111111") } });
  mocks.batch.mockImplementation(async () => f.batch()); mocks.latest.mockResolvedValue(lifetime());
});
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

describe("explicit issuer enrollment preparation (mocked read proof)", () => {
  it("builds the exact shipping instruction with only issuer as signer and fee payer", async () => {
    const value = input(), result = await prepareEnrollment(value);
    const expected = await buildAuthorizeEnrollmentInstruction({ ...value, programAddress: runtime.programAddress });
    expect(result.message.instructions).toEqual([expected.instruction]);
    expect(getSignersFromTransactionMessage(result.message).map(s => s.address)).toEqual([issuer]);
    expect(result.message.feePayer.address).toBe(issuer);
    expect(result).toMatchObject({ sender: issuer, wallet, enrollment: f.a.enrollment, identity: f.a.identity,
      allowance: 1000n, expiresAt: 200n, chainTimestamp: 100n, remainingCampaignAllowance: 3000n,
      totalAuthorized: 2000n, totalMinted: 1000n, observedSlot: 503n, lifetime: lifetime().value });
    expect(result.identityDigest).toEqual(value.identityDigest);
    expect(mocks.batch.mock.calls[0][0]).toEqual([[f.a.config, f.a.featherMint, f.a.enrollment, f.a.identity, clockAddress],
      { commitment: "finalized", encoding: "base64", minContextSlot: 500n }]);
    expect(mocks.latest.mock.calls[0][0]).toEqual([{ commitment: "finalized", minContextSlot: 503n }]);
    expect(mocks.genesis).toHaveBeenCalledTimes(2);
  });

  it.each([2, 3])("refuses any preexisting association at batch index %i", async index => {
    mocks.batch.mockImplementation(async () => { const b = f.batch(); b.value[index] = account(Buffer.alloc(0), sysvar); return b; });
    await expect(prepareEnrollment(input())).rejects.toThrow("already exists");
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("refuses a wrong issuer even when that signer is the configured admin", async () => {
    const value = input(); value.enrollmentAuthority.address = wallet;
    await expect(prepareEnrollment(value)).rejects.toThrow("configured enrollment authority");
  });

  it.each([0n, -1n, 1n << 64n, 1])("rejects invalid allowance %s before RPC", async allowance => {
    await expect(prepareEnrollment({ ...input(), allowance: allowance as bigint })).rejects.toThrow();
    expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it.each([0n, -1n, 1n << 63n, 200])("rejects invalid expiry %s before RPC", async expiresAt => {
    await expect(prepareEnrollment({ ...input(), expiresAt: expiresAt as bigint })).rejects.toThrow();
    expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it.each([99n, 100n])("rejects chain-expired grants %s regardless of local time", async expiresAt => {
    await expect(prepareEnrollment({ ...input(), expiresAt })).rejects.toThrow("chain Clock");
  });

  it.each([0, 31, 33])("rejects digest length %i before RPC", async length => {
    await expect(prepareEnrollment({ ...input(), identityDigest: new Uint8Array(length).fill(1) })).rejects.toThrow("digest");
    expect(mocks.genesis).not.toHaveBeenCalled();
  });
  it("rejects the zero-domain identity digest", async () => {
    await expect(prepareEnrollment({ ...input(), identityDigest: new Uint8Array(32) })).rejects.toThrow("digest");
  });

  it("checks campaign remaining against authorized lifetime allowance, not minted supply", async () => {
    f.config.writeBigUInt64LE(4500n, 156); f.mint.writeBigUInt64LE(0n, 36);
    await expect(prepareEnrollment(input())).rejects.toThrow("remaining campaign cap");
    expect((await prepareEnrollment({ ...input(), allowance: 500n })).remainingCampaignAllowance).toBe(500n);
  });
  it("checks the per-wallet cap independently", async () => {
    await expect(prepareEnrollment({ ...input(), allowance: 1001n })).rejects.toThrow("per-wallet");
  });
  it("rejects exhausted lifetime allowance even after burns", async () => {
    f.config.writeBigUInt64LE(5000n, 156); f.mint.writeBigUInt64LE(0n, 36);
    await expect(prepareEnrollment({ ...input(), allowance: 1n })).rejects.toThrow("remaining campaign cap");
  });
  it("preserves full-u64 allowance arithmetic without wraparound", async () => {
    const max = (1n << 64n) - 1n;
    f.config.writeBigUInt64LE(max, 140); f.config.writeBigUInt64LE(max, 148);
    f.config.writeBigUInt64LE(max - 1n, 156);
    await expect(prepareEnrollment({ ...input(), allowance: 2n })).rejects.toThrow("cap");
    expect((await prepareEnrollment({ ...input(), allowance: 1n })).remainingCampaignAllowance).toBe(1n);
  });

  it.each(["zero-cap", "campaign-below-cap", "authorized-over-cap", "minted-over-authorized", "supply-over-minted", "discriminator", "genesis", "mint"])("rejects invalid config %s", async change => {
    if (change === "zero-cap") f.config.writeBigUInt64LE(0n, 140);
    if (change === "campaign-below-cap") f.config.writeBigUInt64LE(999n, 148);
    if (change === "authorized-over-cap") f.config.writeBigUInt64LE(5001n, 156);
    if (change === "minted-over-authorized") f.config.writeBigUInt64LE(2001n, 164);
    if (change === "supply-over-minted") f.mint.writeBigUInt64LE(1001n, 36);
    if (change === "discriminator") f.config[0] ^= 1;
    if (change === "genesis") f.config[12] ^= 1;
    if (change === "mint") f.config.set(encode.encode(wallet), 108);
    await expect(prepareEnrollment(input())).rejects.toThrow(); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each([0, 1, 4])("rejects missing mandatory batch account %i", async index => {
    mocks.batch.mockImplementation(async () => { const b = f.batch(); b.value[index] = null; return b; });
    await expect(prepareEnrollment(input())).rejects.toThrow();
  });
  it.each([0, 1, 4])("rejects foreign owner of account %i", async index => {
    mocks.batch.mockImplementation(async () => { const b = f.batch(); b.value[index] = { ...b.value[index]!, owner: wallet }; return b; });
    await expect(prepareEnrollment(input())).rejects.toThrow("owner");
  });
  it.each([0, 46])("rejects malformed mint COption at %i", async offset => {
    f.mint.writeUInt32LE(2, offset); await expect(prepareEnrollment(input())).rejects.toThrow("mint encoding");
  });
  it("requires Clock to belong to the same finalized bank", async () => {
    f.clock.writeBigUInt64LE(502n, 0); await expect(prepareEnrollment(input())).rejects.toThrow("Clock does not match");
  });
  it.each([499n, -1n, 1n << 64n, 503])("rejects invalid batch context %s", async slot => {
    mocks.batch.mockImplementation(async () => ({ ...f.batch(), context: { slot } }));
    await expect(prepareEnrollment(input())).rejects.toThrow("context");
  });
  it("rejects a short batch rather than interpreting missing associations as absent", async () => {
    mocks.batch.mockImplementation(async () => ({ ...f.batch(), value: f.batch().value.slice(0, 4) }));
    await expect(prepareEnrollment(input())).rejects.toThrow("length");
  });
  it.each(["initial", "final"])("rejects %s genesis mismatch", async stage => {
    if (stage === "initial") mocks.genesis.mockResolvedValue(wallet);
    else mocks.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce(wallet);
    await expect(prepareEnrollment(input())).rejects.toThrow("genesis"); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it.each(["stale", "negative-height", "number-height", "bad-blockhash"])("rejects invalid lifetime %s", async change => {
    const value = lifetime();
    if (change === "stale") value.context.slot = 502n;
    if (change === "negative-height") value.value.lastValidBlockHeight = -1n;
    if (change === "bad-blockhash") value.value.blockhash = "bad";
    mocks.latest.mockResolvedValue(change === "number-height" ? { ...value, value: { ...value.value, lastValidBlockHeight: 900 } } : value);
    await expect(prepareEnrollment(input())).rejects.toThrow();
  });
  it.each(["batch", "latest"] as const)("propagates %s failure without fallback", async stage => {
    mocks[stage].mockRejectedValue(new Error("RPC unavailable"));
    await expect(prepareEnrollment(input())).rejects.toThrow("RPC unavailable");
  });
  it("snapshots all explicit inputs including identity bytes before awaits", async () => {
    const value = input(), expected = new Uint8Array(value.identityDigest);
    const pending = prepareEnrollment(value);
    value.identityDigest.fill(8); value.wallet = issuer; value.allowance = 1n; value.expiresAt = 1n;
    value.runtime.genesisHash = "wrong"; value.enrollmentAuthority = { address: wallet, signTransactions: mocks.sign };
    expect(await pending).toMatchObject({ identityDigest: expected, wallet, allowance: 1000n, expiresAt: 200n, sender: issuer });
  });
  it("rejects in-place signer address changes", async () => {
    const value = input(); mocks.latest.mockImplementation(async () => { value.enrollmentAuthority.address = wallet; return lifetime(); });
    await expect(prepareEnrollment(value)).rejects.toThrow("authority changed");
  });
  it("honors cancellation before reads and after lifetime", async () => {
    const before = new AbortController(); before.abort();
    await expect(prepareEnrollment({ ...input(), signal: before.signal })).rejects.toThrow();
    expect(mocks.genesis).not.toHaveBeenCalled();
    const after = new AbortController(); mocks.latest.mockImplementation(async () => { after.abort(); return lifetime(); });
    await expect(prepareEnrollment({ ...input(), signal: after.signal })).rejects.toThrow();
  });
});
