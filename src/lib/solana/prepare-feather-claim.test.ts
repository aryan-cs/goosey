import { createHash } from "node:crypto";
import { address, getAddressEncoder, getSignersFromTransactionMessage, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildClaimFeathersInstructions, deriveGooseyEnrollmentAddresses } from "./program-client";
import { prepareFeatherClaim } from "./prepare-feather-claim";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const mocks = vi.hoisted(() => ({ genesis: vi.fn(), account: vi.fn(), batch: vi.fn(), latest: vi.fn(), sign: vi.fn() }));
vi.mock("@solana/kit", async original => ({ ...await original<typeof import("@solana/kit")>(),
  createSolanaRpc: () => ({ getGenesisHash: () => ({ send: mocks.genesis }),
    getAccountInfo: (...args: unknown[]) => ({ send: (options: unknown) => mocks.account(args, options) }),
    getMultipleAccounts: (...args: unknown[]) => ({ send: (options: unknown) => mocks.batch(args, options) }),
    getLatestBlockhash: (...args: unknown[]) => ({ send: (options: unknown) => mocks.latest(args, options) }) }),
}));
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999/",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const wallet = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W") as Address, signTransactions: mocks.sign };
const clockAddress = address("SysvarC1ock11111111111111111111111111111111"), sysvar = address("Sysvar1111111111111111111111111111111111111");
const loader = address("BPFLoaderUpgradeab1e11111111111111111111111");
const input = () => ({ runtime: { ...runtime }, wallet: { ...wallet } });
const hash = (text: string) => createHash("sha256").update(text).digest();
const encode = getAddressEncoder();
const account = (data: Buffer, owner: Address = runtime.programAddress) => ({ owner, executable: false, data: [data.toString("base64"), "base64"] as const });
const lifetime = () => ({ context: { slot: 504n }, value: { blockhash: runtime.genesisHash, lastValidBlockHeight: 900n } });

// Codec fixtures only: mocked RPC responses, never funded or written to chain/DB.
async function fixture() {
  const identityDigest = hash("unit-test identity");
  const a = await deriveGooseyEnrollmentAddresses({ programAddress: runtime.programAddress, wallet: wallet.address, identityDigest });
  const plan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet });
  const config = Buffer.alloc(172), mint = Buffer.alloc(82), enrollment = Buffer.alloc(129), identity = Buffer.alloc(104);
  const token = Buffer.alloc(165), clock = Buffer.alloc(40);
  config.set(hash("account:Config").subarray(0, 8)); config.set([1, 1, a.configBump, a.mintAuthorityBump], 8);
  config.set(hash(runtime.genesisHash), 12); config.set(encode.encode(wallet.address), 44); config.set(encode.encode(wallet.address), 76);
  config.set(encode.encode(a.featherMint), 108);
  config.writeBigUInt64LE(1000n, 140); config.writeBigUInt64LE(5000n, 148); config.writeBigUInt64LE(2000n, 156); config.writeBigUInt64LE(1000n, 164);
  mint.writeUInt32LE(1, 0); mint.set(encode.encode(a.mintAuthority), 4); mint.writeBigUInt64LE(1000n, 36); mint[44] = 3; mint[45] = 1;
  for (const [bytes, name] of [[enrollment, "Enrollment"], [identity, "EnrollmentIdentity"]] as const) {
    bytes.set(hash(`account:${name}`).subarray(0, 8)); bytes.set(encode.encode(a.config), 8);
    bytes.set(encode.encode(wallet.address), 40); bytes.set(identityDigest, 72);
  }
  enrollment.writeBigUInt64LE(1000n, 104); enrollment.writeBigUInt64LE(0n, 112); enrollment.writeBigInt64LE(200n, 120); enrollment[128] = a.enrollmentBump;
  token.set(encode.encode(a.featherMint), 0); token.set(encode.encode(wallet.address), 32); token.writeBigUInt64LE(500n, 64); token[108] = 1;
  clock.writeBigUInt64LE(503n, 0); clock.writeBigInt64LE(100n, 32);
  return { a, plan, config, mint, enrollment, identity, token, clock,
    batch: () => ({ context: { slot: 503n }, value: [account(config), account(mint, TOKEN_PROGRAM_ADDRESS), account(enrollment),
      account(identity), account(token, TOKEN_PROGRAM_ADDRESS), account(clock, sysvar)] as (ReturnType<typeof account> | null)[] }) };
}
let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  vi.resetAllMocks(); f = await fixture();
  mocks.genesis.mockResolvedValue(runtime.genesisHash);
  mocks.account.mockImplementation(async ([key]: Address[]) => key === runtime.programAddress
    ? { context: { slot: 500n }, value: { executable: true, owner: loader } }
    : { context: { slot: 501n }, value: account(f.enrollment) });
  mocks.batch.mockImplementation(async () => f.batch()); mocks.latest.mockResolvedValue(lifetime());
});
afterEach(() => expect(mocks.sign).not.toHaveBeenCalled());

describe("feather claim preparation: mocked RPC, real account codecs and builders, not execution proof", () => {
  it("prepares exact wallet-only claim from one finalized batch and chain time, not local time", async () => {
    const result = await prepareFeatherClaim(input()); const contract: PreparedWalletTransaction = result;
    expect(contract.sender).toBe(wallet.address);
    expect(result).toMatchObject({ amount: 1000n, allowance: 1000n, claimed: 0n, chainTimestamp: 100n, expiresAt: 200n,
      observedSlot: 503n, observedBalance: 500n, createsAta: false, enrollment: f.a.enrollment, identity: f.a.identity });
    expect(mocks.batch.mock.calls[0]![0]).toEqual([[f.a.config, f.a.featherMint, f.a.enrollment, f.a.identity, f.plan.walletTokens, clockAddress],
      { encoding: "base64", commitment: "finalized", minContextSlot: 501n }]);
    expect(mocks.account.mock.calls[1]![0]).toEqual([f.a.enrollment, { encoding: "base64", commitment: "finalized", minContextSlot: 500n }]);
    expect(result.message.instructions).toEqual(f.plan.instructions);
    expect(getSignersFromTransactionMessage(result.message).map(s => s.address)).toEqual([wallet.address]);
    expect(result.message.feePayer.address).toBe(wallet.address);
    expect(result.message.lifetimeConstraint).toEqual(lifetime().value);
    expect(mocks.latest.mock.calls[0]![0]).toEqual([{ commitment: "finalized", minContextSlot: 503n }]);
  });
  it("uses shipping idempotent ATA builder with wallet as sole rent/fee payer when missing", async () => {
    mocks.batch.mockImplementation(async () => { const response = f.batch(); response.value[4] = null; return response; });
    const result = await prepareFeatherClaim(input());
    const expected = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet, createAta: true });
    expect(result.message.instructions).toEqual(expected.instructions);
    expect(result.message.instructions[0]!.programAddress).toBe(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    expect(result.message.instructions[0]!.data).toEqual(new Uint8Array([1]));
    expect(getSignersFromTransactionMessage(result.message).map(s => s.address)).toEqual([wallet.address]);
    expect(result).toMatchObject({ createsAta: true, amount: 1000n, observedBalance: 0n });
  });
  it("uses final enrollment amount, never discovery balances or caller overrides", async () => {
    const original = account(f.enrollment);
    mocks.account.mockImplementation(async ([key]: Address[]) => key === runtime.programAddress
      ? { context: { slot: 500n }, value: { executable: true, owner: loader } } : { context: { slot: 501n }, value: original });
    f.enrollment.writeBigUInt64LE(400n, 112);
    const value = { ...input(), amount: 9999n, identityDigest: new Uint8Array(32), payer: { ...wallet, address: TOKEN_PROGRAM_ADDRESS } };
    const pending = prepareFeatherClaim(value); value.runtime.genesisHash = "wrong"; value.wallet = { ...wallet, address: TOKEN_PROGRAM_ADDRESS };
    expect(await pending).toMatchObject({ amount: 600n, sender: wallet.address, genesisHash: runtime.genesisHash });
  });
  it.each([100n, 99n, 0n, -1n])("rejects expired/nonpositive grant timestamp %s", async expiresAt => {
    f.enrollment.writeBigInt64LE(expiresAt, 120);
    await expect(prepareFeatherClaim(input())).rejects.toThrow("expired"); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects replay even after expiration", async () => {
    f.enrollment.writeBigUInt64LE(1000n, 112); f.enrollment.writeBigInt64LE(1n, 120);
    await expect(prepareFeatherClaim(input())).rejects.toThrow("already claimed");
  });
  it.each([[104, 0n], [104, 1001n], [112, 1001n]] as const)("rejects invalid grant field %i %s", async (offset, value) => {
    f.enrollment.writeBigUInt64LE(value, offset); await expect(prepareFeatherClaim(input())).rejects.toThrow("allowance");
  });
  it("rejects grant inconsistent with campaign/lifetime authorization", async () => {
    f.config.writeBigUInt64LE(1500n, 156);
    await expect(prepareFeatherClaim(input())).rejects.toThrow("allowance");
  });
  it("preserves amounts above number precision and does not reopen issuance after burns", async () => {
    const amount = 9_007_199_254_740_993n;
    f.config.writeBigUInt64LE(amount, 140); f.config.writeBigUInt64LE(amount + 1000n, 148);
    f.config.writeBigUInt64LE(amount + 1000n, 156); f.enrollment.writeBigUInt64LE(amount, 104);
    f.mint.writeBigUInt64LE(500n, 36);
    expect(await prepareFeatherClaim(input())).toMatchObject({ amount, observedBalance: 500n });
    f.config.writeBigUInt64LE(amount + 1000n, 164);
    await expect(prepareFeatherClaim(input())).rejects.toThrow("allowance");
  });
  it("rejects mainnet, zero wallet and invalid program deployment", async () => {
    await expect(prepareFeatherClaim({ ...input(), runtime: { ...runtime, cluster: "mainnet" as "localnet" } })).rejects.toThrow("mainnet");
    await expect(prepareFeatherClaim({ ...input(), wallet: { ...wallet, address: address("11111111111111111111111111111111") } })).rejects.toThrow("nonzero");
    expect(mocks.account).not.toHaveBeenCalled();
    mocks.account.mockResolvedValueOnce({ context: { slot: 500n }, value: { executable: true, owner: TOKEN_PROGRAM_ADDRESS } });
    await expect(prepareFeatherClaim(input())).rejects.toThrow("loader"); expect(mocks.batch).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 5])("rejects missing required account %i", async index => {
    mocks.batch.mockImplementation(async () => { const response = f.batch(); response.value[index] = null; return response; });
    await expect(prepareFeatherClaim(input())).rejects.toThrow();
  });
  it.each([0, 1, 2, 3, 4, 5])("rejects hostile owner/executable/size/encoding at account %i", async index => {
    for (const patch of [{ owner: wallet.address }, { executable: true }, { data: ["AA==", "base64"] }, { data: ["", "jsonParsed"] }]) {
      mocks.batch.mockImplementation(async () => { const response = f.batch(); Object.assign(response.value[index]!, patch); return response; });
      await expect(prepareFeatherClaim(input())).rejects.toThrow();
    }
  });
  it.each(["config", "enrollment", "identity"] as const)("rejects %s discriminator", async name => {
    f[name][0] ^= 1; await expect(prepareFeatherClaim(input())).rejects.toThrow("discriminator");
  });
  it.each([8, 40, 72, 128])("rejects enrollment binding corruption at %i", async offset => {
    // Keep discovery correct so the final digest/bump comparison is tested.
    const original = account(f.enrollment); const base = mocks.account.getMockImplementation()!;
    mocks.account.mockImplementation(async (args, options) => args[0] === f.a.enrollment
      ? { context: { slot: 501n }, value: original } : base(args, options));
    f.enrollment[offset] ^= 1; await expect(prepareFeatherClaim(input())).rejects.toThrow(/binding|bump/);
  });
  it.each([8, 40, 72])("rejects identity cross-binding corruption at %i", async offset => {
    f.identity[offset] ^= 1; await expect(prepareFeatherClaim(input())).rejects.toThrow("binding");
  });
  it.each([0, 4, 44, 45, 46])("rejects wrong mint authority/precision/flags at %i", async offset => {
    f.mint[offset] ^= 1; await expect(prepareFeatherClaim(input())).rejects.toThrow();
  });
  it.each([0, 32, 108, 109])("rejects wrong ATA mint/wallet/state/native at %i", async offset => {
    f.token[offset] ^= 1; await expect(prepareFeatherClaim(input())).rejects.toThrow();
  });
  it("rejects frozen or over-supply token account", async () => {
    f.token[108] = 2; await expect(prepareFeatherClaim(input())).rejects.toThrow("state");
    f.token[108] = 1; f.token.writeBigUInt64LE(1001n, 64); await expect(prepareFeatherClaim(input())).rejects.toThrow("supply");
  });
  it("rejects unknown enrollment without fabricating or authorizing a grant", async () => {
    const base = mocks.account.getMockImplementation()!;
    mocks.account.mockImplementation(async (args, options) => args[0] === f.a.enrollment
      ? { context: { slot: 501n }, value: null } : base(args, options));
    await expect(prepareFeatherClaim(input())).rejects.toThrow(); expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("rejects stale/incoherent Clock and RPC contexts", async () => {
    f.clock.writeBigUInt64LE(502n, 0); await expect(prepareFeatherClaim(input())).rejects.toThrow("Clock"); f.clock.writeBigUInt64LE(503n, 0);
    for (const slot of [500n, 503]) {
      mocks.batch.mockImplementation(async () => ({ ...f.batch(), context: { slot } }));
      await expect(prepareFeatherClaim(input())).rejects.toThrow("context");
    }
  });
  it("rejects network drift both before snapshot and signing lifetime", async () => {
    mocks.genesis.mockResolvedValueOnce("wrong"); await expect(prepareFeatherClaim(input())).rejects.toThrow("genesis mismatch");
    expect(mocks.batch).not.toHaveBeenCalled();
    mocks.genesis.mockResolvedValueOnce(runtime.genesisHash).mockResolvedValueOnce("wrong");
    await expect(prepareFeatherClaim(input())).rejects.toThrow("genesis changed"); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("rejects stale/malformed signing lifetime", async () => {
    for (const value of [{ ...lifetime(), context: { slot: 502n } }, { ...lifetime(), context: { slot: 504 } },
      { ...lifetime(), value: { blockhash: "bad", lastValidBlockHeight: 1n } },
      { ...lifetime(), value: { blockhash: runtime.genesisHash, lastValidBlockHeight: -1n } }]) {
      mocks.latest.mockResolvedValue(value); await expect(prepareFeatherClaim(input())).rejects.toThrow();
    }
  });
  it("rejects wallet mutation while awaiting lifetime", async () => {
    const value = input(); mocks.latest.mockImplementationOnce(async () => { value.wallet.address = TOKEN_PROGRAM_ADDRESS; return lifetime(); });
    await expect(prepareFeatherClaim(value)).rejects.toThrow("Wallet changed");
  });
  it("propagates abort and transport failures without signing or retry", async () => {
    const before = new AbortController(); before.abort(new Error("Canceled"));
    await expect(prepareFeatherClaim({ ...input(), signal: before.signal })).rejects.toThrow("Canceled"); expect(mocks.account).not.toHaveBeenCalled();
    mocks.batch.mockRejectedValueOnce(new Error("RPC unavailable")); await expect(prepareFeatherClaim(input())).rejects.toThrow("RPC unavailable");
    const during = new AbortController(); mocks.latest.mockImplementationOnce(async () => { during.abort(new Error("Canceled in flight")); return lifetime(); });
    await expect(prepareFeatherClaim({ ...input(), signal: during.signal })).rejects.toThrow("Canceled in flight");
    expect(mocks.latest.mock.calls[0]![1].abortSignal).toBe(during.signal);
  });
});
