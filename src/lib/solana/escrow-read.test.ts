import { createHash } from "node:crypto";
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { readGooseyEscrow, verifyGooseyEscrowSnapshot, type EscrowReadRpc, type EscrowSnapshotAccounts } from "./escrow-read";

const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:18999",
  programAddress: address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q"), genesisHash: "Bax5P2GmYBb2P6UjJFmEVys7cpRzY4A85ncAJqtgvSsm" };
const input = { wallet: TOKEN_PROGRAM_ADDRESS, marketId: 7n };
const seatsAddress = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;
const amount = 9_007_199_254_740_993n;
const key = (buffer: Buffer, offset: number, value: Address) => buffer.set(getAddressEncoder().encode(value), offset);
const anchor = (size: number, name: string) => {
  const bytes = Buffer.alloc(size);
  bytes.set(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));
  return bytes;
};
// Codec/RPC fixtures only. No data here is deployed or presented as live balances.
async function fixture() {
  const p = await deriveGooseySeatAddresses({ ...input, programAddress: runtime.programAddress });
  const config = anchor(172, "Config"), mint = Buffer.alloc(82), market = anchor(195, "Market"),
    seats = anchor(32_816, "Seats"), locator = anchor(77, "SeatLocator"), vault = Buffer.alloc(165), walletTokens = Buffer.alloc(165);
  config.set([1, 1, p.configBump, p.mintAuthorityBump], 8);
  config.set(createHash("sha256").update(runtime.genesisHash).digest(), 12);
  key(config, 44, input.wallet); key(config, 76, input.wallet); key(config, 108, p.featherMint);
  for (const offset of [140, 148, 156, 164]) config.writeBigUInt64LE(amount + 100n, offset);
  mint.writeUInt32LE(1); key(mint, 4, p.mintAuthority); mint.writeBigUInt64LE(amount + 100n, 36); mint[44] = 3; mint[45] = 1;
  key(market, 8, p.config); key(market, 40, input.wallet); key(market, 72, seatsAddress); key(market, 104, p.vault);
  market.writeBigUInt64LE(7n, 136); market.writeBigUInt64LE(100_000n, 144);
  market.writeBigInt64LE(2_000_000_000n, 152); market.writeBigInt64LE(2_000_000_001n, 160);
  market.writeBigUInt64LE(amount, 168); market.writeUInt16LE(250, 192); market[194] = p.marketBump;
  key(seats, 8, p.market); seats.writeUInt32LE(1, 40); key(seats, 48, input.wallet); key(seats, 80, p.enrollment);
  seats.writeBigUInt64LE(amount, 112); seats.writeBigUInt64LE(amount + 1n, 160);
  key(locator, 8, p.market); key(locator, 40, input.wallet); locator[76] = p.locatorBump;
  for (const [buffer, owner, balance] of [[vault, p.market, amount + 3n], [walletTokens, input.wallet, 5n]] as const) {
    key(buffer, 0, p.featherMint); key(buffer, 32, owner); buffer.writeBigUInt64LE(balance, 64); buffer[108] = 1;
  }
  const account = (data: Buffer, owner: Address = runtime.programAddress) => ({ owner, executable: false, data: [data.toString("base64"), "base64"] as const });
  const accounts = (): EscrowSnapshotAccounts => ({ config: account(config), mint: account(mint, TOKEN_PROGRAM_ADDRESS),
    market: account(market), seats: account(seats), locator: account(locator), vault: account(vault, TOKEN_PROGRAM_ADDRESS),
    walletTokens: account(walletTokens, TOKEN_PROGRAM_ADDRESS) });
  const verify = () => verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, accounts());
  return { p, config, mint, market, seats, locator, vault, walletTokens, account, accounts, verify };
}

describe("strict escrow foundation snapshot", () => {
  it("preserves large exact balances/nonce and distinguishes donated surplus", async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({ registered: true, seat: { index: 0, availableCash: amount, nextNonce: amount + 1n },
      seats: seatsAddress, market: f.p.market, vaultAmount: amount + 3n, vaultSurplus: 3n, walletTokenAmount: 5n, exchangeVerified: false });
  });
  it("allows absent ATA without manufacturing a balance, and absent registration only if no seat exists", async () => {
    const f = await fixture();
    expect((await verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, { ...f.accounts(), walletTokens: null })).walletTokenAmount).toBeNull();
    await expect(verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, { ...f.accounts(), locator: null })).rejects.toThrow("Missing locator");
    f.seats.fill(0, 40); f.market.writeBigUInt64LE(0n, 168);
    expect(await verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, { ...f.accounts(), locator: null })).toMatchObject({ registered: false, seat: null });
    await expect(f.verify()).rejects.toThrow("locator");
  });
  it.each([8, 40, 72, 104, 136, 194])("rejects market canonical binding corruption at %i", async offset => {
    const f = await fixture(); f.market[offset] ^= 1; await expect(f.verify()).rejects.toThrow();
  });
  it.each([8, 40, 72, 76])("rejects locator binding/index/bump corruption at %i", async offset => {
    const f = await fixture(); f.locator[offset] ^= 1; await expect(f.verify()).rejects.toThrow("locator");
  });
  it("rejects missing/wrong-owner/executable/wrong-size/encoding/discriminator accounts", async () => {
    const f = await fixture();
    for (const name of ["market", "seats", "locator", "vault", "config", "mint"] as const) {
      const original = f.accounts()[name]!;
      for (const invalid of [null, { ...original, owner: address("11111111111111111111111111111111") },
        { ...original, executable: true }, { ...original, data: [original.data[0] + "AAAA", "base64"] as const }]) {
        await expect(verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, { ...f.accounts(), [name]: invalid })).rejects.toThrow();
      }
    }
    for (const bytes of [f.market, f.seats, f.locator]) {
      bytes[0] ^= 1; await expect(f.verify()).rejects.toThrow("discriminator"); bytes[0] ^= 1;
    }
    await expect(verifyGooseyEscrowSnapshot(runtime, input, seatsAddress, { ...f.accounts(),
      market: { ...f.accounts().market!, data: ["!".repeat(260), "base64"] } })).rejects.toThrow();
  });
  it("rejects cash loss, vault underfunding, and token supply violations", async () => {
    const f = await fixture();
    f.seats.writeBigUInt64LE(amount - 1n, 112); await expect(f.verify()).rejects.toThrow("reconcile");
    f.seats.writeBigUInt64LE(amount, 112); f.vault.writeBigUInt64LE(amount - 1n, 64); await expect(f.verify()).rejects.toThrow("backing");
    f.vault.writeBigUInt64LE(amount + 100n, 64); await expect(f.verify()).rejects.toThrow("supply");
  });
  it("reconciles other wallets too, without adding their cash to the selected wallet", async () => {
    const f = await fixture();
    const other = await deriveGooseySeatAddresses({ ...input, wallet: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, programAddress: runtime.programAddress });
    f.seats.writeUInt32LE(2, 40);
    key(f.seats, 176, ASSOCIATED_TOKEN_PROGRAM_ADDRESS); key(f.seats, 208, other.enrollment);
    f.seats.writeBigUInt64LE(2n, 240); f.market.writeBigUInt64LE(amount + 2n, 168);
    expect(await f.verify()).toMatchObject({ seat: { availableCash: amount }, vaultSurplus: 1n });
    f.seats.writeBigUInt64LE(1n, 240);
    await expect(f.verify()).rejects.toThrow("reconcile");
  });
  it.each([8, 44, 80, 120, 168, 175, 176])("rejects seat header/enrollment/trading/padding/unused corruption at %i", async offset => {
    const f = await fixture(); f.seats[offset] ^= 1; await expect(f.verify()).rejects.toThrow();
  });
  it("rejects excessive count and duplicate occupied wallets", async () => {
    const f = await fixture(); f.seats.writeUInt32LE(257, 40); await expect(f.verify()).rejects.toThrow("header");
    f.seats.writeUInt32LE(2, 40); f.seats.copy(f.seats, 176, 48, 176); await expect(f.verify()).rejects.toThrow("duplicate");
  });
  it.each([0, 32, 72, 108, 109, 121, 129])("rejects vault mint/owner/delegate/state/native/authority corruption at %i", async offset => {
    const f = await fixture(); f.vault[offset] ^= 1; await expect(f.verify()).rejects.toThrow();
  });
  it("rejects changed market economics and unsupported future trading layout", async () => {
    const f = await fixture();
    for (const [offset, value] of [[144, 1n], [152, 0n], [160, 1n], [176, 1n], [184, 1n]] as const) {
      const old = f.market.readBigUInt64LE(offset); f.market.writeBigUInt64LE(value, offset);
      await expect(f.verify()).rejects.toThrow(); f.market.writeBigUInt64LE(old, offset);
    }
    f.market.writeUInt16LE(10_001, 192); await expect(f.verify()).rejects.toThrow();
  });
});

describe("finalized read orchestration (mocked RPC, not chain proof)", () => {
  async function setup() {
    const f = await fixture();
    const batch = vi.fn().mockResolvedValueOnce({ context: { slot: 11n }, value: [f.account(f.market)] })
      .mockResolvedValueOnce({ context: { slot: 12n }, value: Object.values(f.accounts()) });
    const getMultipleAccounts = vi.fn(() => ({ send: batch }));
    const rpc = { getGenesisHash: () => ({ send: async () => runtime.genesisHash }),
      getAccountInfo: () => ({ send: async () => ({ context: { slot: 10n }, value: {
        executable: true, owner: address("BPFLoaderUpgradeab1e11111111111111111111111"),
      } }) }), getMultipleAccounts } as unknown as EscrowReadRpc;
    return { ...f, rpc, batch, getMultipleAccounts };
  }
  it("pins network then re-reads market and all balances in one finalized batch", async () => {
    const f = await setup();
    expect(await readGooseyEscrow(runtime, input, { rpc: f.rpc })).toMatchObject({ finalizedSlot: 12n, vaultSurplus: 3n });
    expect(f.getMultipleAccounts.mock.calls).toEqual([
      [[f.p.market], { encoding: "base64", commitment: "finalized", minContextSlot: 10n }],
      [[f.p.config, f.p.featherMint, f.p.market, seatsAddress, f.p.locator, f.p.vault, f.p.walletTokens],
        { encoding: "base64", commitment: "finalized", minContextSlot: 11n }],
    ]);
  });
  it("rejects stale snapshot context, short batches, and changed Seats binding", async () => {
    for (const mode of ["stale", "short", "binding"] as const) {
      const f = await setup();
      const initial = f.account(f.market);
      if (mode === "binding") key(f.market, 72, input.wallet);
      f.batch.mockReset().mockResolvedValueOnce({ context: { slot: 11n }, value: [initial] })
        .mockResolvedValueOnce({ context: { slot: mode === "stale" ? 10n : 12n },
          value: mode === "short" ? [] : Object.values(f.accounts()) });
      await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc })).rejects.toThrow();
    }
  });
  it("propagates read errors and caller abort without inventing balances", async () => {
    const f = await setup(); f.batch.mockReset().mockRejectedValue(new Error("RPC unavailable"));
    await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc })).rejects.toThrow("RPC unavailable");
    const controller = new AbortController(); controller.abort(new Error("Canceled"));
    await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, signal: controller.signal })).rejects.toThrow("Canceled");
  });
});
