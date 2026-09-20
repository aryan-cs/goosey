import { createHash } from "node:crypto";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { deriveGooseyMarketTermsAddresses } from "./market-terms-client";
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

describe("strict escrow and matcher snapshot", () => {
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
  it.each([8, 44, 80, 120, 169, 175, 176])("rejects seat header/enrollment/reserve/padding/unused corruption at %i", async offset => {
    const f = await fixture(); f.seats[offset] ^= 1; await expect(f.verify()).rejects.toThrow();
  });
  it("rejects excessive count and duplicate occupied wallets", async () => {
    const f = await fixture(); f.seats.writeUInt32LE(257, 40); await expect(f.verify()).rejects.toThrow("header");
    f.seats.writeUInt32LE(2, 40); f.seats.copy(f.seats, 176, 48, 176); await expect(f.verify()).rejects.toThrow("duplicate");
  });
  it.each([0, 32, 72, 108, 109, 121, 129])("rejects vault mint/owner/delegate/state/native/authority corruption at %i", async offset => {
    const f = await fixture(); f.vault[offset] ^= 1; await expect(f.verify()).rejects.toThrow();
  });
  it("rejects invalid market parameters and unreconciled collateral/fees", async () => {
    const f = await fixture();
    for (const [offset, value] of [[144, 1n], [152, 0n], [160, 1n], [176, 1n], [184, 1n]] as const) {
      const old = f.market.readBigUInt64LE(offset); f.market.writeBigUInt64LE(value, offset);
      await expect(f.verify()).rejects.toThrow(); f.market.writeBigUInt64LE(old, offset);
    }
    f.market.writeUInt16LE(10_001, 192); await expect(f.verify()).rejects.toThrow();
  });
});

async function matchedFixture() {
  const f = await fixture();
  const other = await deriveGooseySeatAddresses({ ...input, wallet: ASSOCIATED_TOKEN_PROGRAM_ADDRESS, programAddress: runtime.programAddress });
  f.seats.writeUInt32LE(2, 40);
  key(f.seats, 176, ASSOCIATED_TOKEN_PROGRAM_ADDRESS); key(f.seats, 208, other.enrollment);
  // Three complete pairs backed by collateral; YES and NO held by different
  // wallets. Position reservations are subsets, cash reservations are separate.
  f.seats.writeBigUInt64LE(amount - 300_000n - 7n - 17n - 11n - 29n, 112);
  f.seats.writeBigUInt64LE(29n, 120); f.seats.writeBigUInt64LE(3n, 128); f.seats.writeBigUInt64LE(2n, 144); f.seats[168] = 1;
  f.seats.writeBigUInt64LE(17n, 240); f.seats.writeBigUInt64LE(11n, 248);
  f.seats.writeBigUInt64LE(3n, 264); f.seats.writeBigUInt64LE(1n, 280); f.seats.writeBigUInt64LE(2n, 288); f.seats[296] = 1;
  f.market.writeBigUInt64LE(300_000n, 176); f.market.writeBigUInt64LE(7n, 184);
  return f;
}

describe("matcher aggregate invariants (not order-book reserve proof)", () => {
  it("decodes real fields with collateral/fees and does not double-count reserved positions", async () => {
    const f = await matchedFixture();
    expect(await f.verify()).toMatchObject({ seat: {
      availableCash: amount - 300_064n, reservedCash: 29n, yes: 3n, no: 0n,
      reservedYes: 2n, reservedNo: 0n, nextNonce: amount + 1n, everTraded: true,
    }, marketState: { accountedVault: amount, collateral: 300_000n, feeRevenue: 7n },
    vaultSurplus: 3n, exchangeVerified: false });
  });
  it("allows resting cash reservations before the wallet has traded", async () => {
    const f = await fixture(); f.seats.writeBigUInt64LE(amount - 5n, 112); f.seats.writeBigUInt64LE(5n, 120);
    expect(await f.verify()).toMatchObject({ seat: { availableCash: amount - 5n, reservedCash: 5n, everTraded: false } });
  });
  it.each([144, 152, 272, 280])("rejects over-reserved positions in either outcome/any seat at %i", async offset => {
    const f = await matchedFixture(); f.seats.writeBigUInt64LE(4n, offset);
    await expect(f.verify()).rejects.toThrow("Reserved positions");
  });
  it.each([112, 120, 240, 248, 176, 184])("rejects unreconciled cash/collateral/fees at %i", async offset => {
    const f = await matchedFixture();
    const bytes = offset === 176 || offset === 184 ? f.market : f.seats;
    bytes.writeBigUInt64LE(bytes.readBigUInt64LE(offset) + 1n, offset);
    await expect(f.verify()).rejects.toThrow("accounted vault");
  });
  it("rejects unequal YES/NO and undercollateralization even when cash still reconciles", async () => {
    const f = await matchedFixture();
    f.seats.writeBigUInt64LE(4n, 264); await expect(f.verify()).rejects.toThrow("YES/NO");
    f.seats.writeBigUInt64LE(4n, 128); await expect(f.verify()).rejects.toThrow("collateral");
  });
  it.each([168, 296])("rejects non-boolean ever_traded at %i", async offset => {
    const f = await matchedFixture(); f.seats[offset] = 2; await expect(f.verify()).rejects.toThrow("flag");
  });
  it("preserves quantities above Number precision and exact bigint collateral multiplication", async () => {
    const f = await matchedFixture();
    for (const offset of [112, 120, 240, 248]) f.seats.writeBigUInt64LE(0n, offset);
    f.seats.writeBigUInt64LE(amount, 128); f.seats.writeBigUInt64LE(amount, 264);
    f.seats.writeBigUInt64LE(amount, 144); f.seats.writeBigUInt64LE(amount, 280);
    f.market.writeBigUInt64LE(2n, 144); f.market.writeBigUInt64LE(amount * 2n, 168);
    f.market.writeBigUInt64LE(amount * 2n, 176); f.market.writeBigUInt64LE(0n, 184);
    for (const offset of [140, 148, 156, 164]) f.config.writeBigUInt64LE(amount * 2n + 100n, offset);
    f.mint.writeBigUInt64LE(amount * 2n + 100n, 36); f.vault.writeBigUInt64LE(amount * 2n + 3n, 64);
    expect(await f.verify()).toMatchObject({ seat: { yes: amount, reservedYes: amount },
      marketState: { collateral: amount * 2n }, vaultSurplus: 3n });
    f.seats.writeBigUInt64LE(amount + 1n, 128); f.seats.writeBigUInt64LE(amount + 1n, 264);
    await expect(f.verify()).rejects.toThrow("collateral");
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
  it("honors a stricter caller-provided finalized slot for post-transaction verification", async () => {
    const f = await setup();
    await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, minimumFinalizedSlot: 11n }))
      .resolves.toMatchObject({ finalizedSlot: 12n });
    const firstCall = f.getMultipleAccounts.mock.calls[0] as unknown as readonly [unknown, { minContextSlot: bigint }];
    expect(firstCall[1]).toMatchObject({ minContextSlot: 11n });

    const stale = await setup();
    await expect(readGooseyEscrow(runtime, input, { rpc: stale.rpc, minimumFinalizedSlot: 12n }))
      .rejects.toThrow("discovery snapshot");
  });
  async function setupBook() {
    const f = await setup(), book = Buffer.alloc(69_720);
    book.set(Buffer.from("GOOSEYB1")); key(book, 8, f.p.market);
    book.writeBigUInt64LE(1n, 40); book.writeBigUInt64LE(100_000n, 48);
    book.writeBigUInt64LE(1n, 64); book.writeUInt16LE(1024, 72); book.writeUInt16LE(250, 82);
    for (let i = 0; i < 1024; i++) book.writeUInt16LE(i === 1023 ? 65535 : i + 1, 88 + i * 64 + 58);
    book.fill(255, 65_624);
    const configure = (value: unknown = f.account(book), slot = 12n) => f.batch.mockReset()
      .mockResolvedValueOnce({ context: { slot: 11n }, value: [f.account(f.market)] })
      .mockResolvedValueOnce({ context: { slot }, value: [...Object.values(f.accounts()), value] });
    configure(); return { ...f, book, configure };
  }
  it("verifies full order reserves and token backing from the same finalized batch", async () => {
    const f = await setupBook();
    const result = await readGooseyEscrow(runtime, input, { rpc: f.rpc, includeOrderBook: true });
    expect(result).toMatchObject({ finalizedSlot: 12n, vaultSurplus: 3n,
      orderBook: { orders: [], reservesReconciled: true, revision: 0n, nextSequence: 1n }, exchangeVerified: false });
    const { book } = await deriveGooseyBookAddress(runtime.programAddress, f.p.market);
    expect(f.getMultipleAccounts).toHaveBeenCalledTimes(2);
    expect(f.getMultipleAccounts.mock.calls[1]).toEqual([
      [f.p.config, f.p.featherMint, f.p.market, seatsAddress, f.p.locator, f.p.vault, f.p.walletTokens, book],
      { encoding: "base64", commitment: "finalized", minContextSlot: 11n },
    ]);
  });
  it("fails closed on missing, draft, foreign or malformed book instead of returning aggregate-only success", async () => {
    for (const mode of ["missing", "draft", "foreign", "executable", "encoding", "stale"] as const) {
      const f = await setupBook();
      if (mode === "draft") f.book.set(Buffer.from("GOOSEYI1"));
      let account: unknown = f.account(f.book);
      if (mode === "missing") account = null;
      if (mode === "foreign") account = f.account(f.book, TOKEN_PROGRAM_ADDRESS);
      if (mode === "executable") account = { ...f.account(f.book), executable: true };
      if (mode === "encoding") account = { ...f.account(f.book), data: ["invalid", "base64"] };
      f.configure(account, mode === "stale" ? 10n : 12n);
      await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, includeOrderBook: true })).rejects.toThrow();
    }
  });
  it("rejects economically balanced but unsupported reserved cash", async () => {
    const f = await setupBook();
    f.seats.writeBigUInt64LE(amount - 1n, 112); f.seats.writeBigUInt64LE(1n, 120);
    f.configure();
    await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, includeOrderBook: true })).rejects.toThrow("full book");
  });
  async function setupResolution() {
    const f = await setupBook(), resolution = anchor(268, "ResolutionState");
    key(resolution, 8, f.p.market); key(resolution, 40, input.wallet);
    resolution.writeBigUInt64LE(100_000n, 72); resolution.writeBigInt64LE(2_000_000_000n, 80); resolution.writeBigInt64LE(2_000_000_001n, 88);
    for (const [index, wallet] of [seatsAddress, runtime.programAddress].entries()) {
      const [enrollment] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
        seeds: ["enrollment", getAddressEncoder().encode(f.p.config), getAddressEncoder().encode(wallet)] });
      key(resolution, 96 + index * 64, wallet); key(resolution, 128 + index * 64, enrollment);
    }
    resolution.writeBigUInt64LE(1n, 225);
    const [resolutionAddress] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
      seeds: ["resolution", getAddressEncoder().encode(f.p.market)] });
    const configureResolution = (account: unknown = f.account(resolution)) => f.batch.mockReset()
      .mockResolvedValueOnce({ context: { slot: 11n }, value: [f.account(f.market)] })
      .mockResolvedValueOnce({ context: { slot: 12n }, value: [...Object.values(f.accounts()), f.account(f.book), account] });
    configureResolution(); return { ...f, resolution, resolutionAddress, configureResolution };
  }
  it("loads resolution with book and all financial accounts in exactly one finalized batch", async () => {
    const f = await setupResolution();
    const result = await readGooseyEscrow(runtime, input, { rpc: f.rpc, includeResolution: true });
    expect(result.resolution).toMatchObject({ address: f.resolutionAddress, phase: 0, nextProposalSequence: 1n });
    expect(result.orderBook?.reservesReconciled).toBe(true);
    expect(f.getMultipleAccounts).toHaveBeenCalledTimes(2);
    const { book } = await deriveGooseyBookAddress(runtime.programAddress, f.p.market);
    expect(f.getMultipleAccounts).toHaveBeenNthCalledWith(2,
      [f.p.config, f.p.featherMint, f.p.market, seatsAddress, f.p.locator, f.p.vault, f.p.walletTokens, book, f.resolutionAddress],
      { encoding: "base64", commitment: "finalized", minContextSlot: 11n });
    expect(result.finalizedSlot).toBe(12n);
  });
  it("never downgrades missing or malformed required resolution state to legacy checks", async () => {
    for (const mode of ["missing", "owner", "binding", "outstanding"] as const) {
      const f = await setupResolution();
      if (mode === "binding") f.resolution[8] ^= 1;
      if (mode === "outstanding") f.resolution.writeBigUInt64LE(1n, 235);
      f.configureResolution(mode === "missing" ? null : f.account(f.resolution, mode === "owner" ? TOKEN_PROGRAM_ADDRESS : runtime.programAddress));
      await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, includeResolution: true })).rejects.toThrow();
    }
  });
  async function setupTerms() {
    const f = await setupResolution(), terms = anchor(240, "MarketTerms");
    const a = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId: input.marketId });
    terms[8] = 1; key(terms, 9, f.p.market); key(terms, 41, input.wallet);
    terms.fill(1, 73, 105); terms.writeUInt32LE(1000, 105);
    terms.set(f.resolution.subarray(96, 224), 109);
    terms[237] = 3; terms[238] = 1; terms[239] = a.termsBump;
    const configureTerms = (account: unknown = f.account(terms), short = false) => f.batch.mockReset()
      .mockResolvedValueOnce({ context: { slot: 11n }, value: [f.account(f.market)] })
      .mockResolvedValueOnce({ context: { slot: 12n }, value: [...Object.values(f.accounts()), f.account(f.book),
        f.account(f.resolution), ...(short ? [] : [account])] });
    configureTerms(); return { ...f, terms, termsAddress: a.terms, configureTerms };
  }
  it("verifies terms and frozen reviewers in the same ten-account finalized financial batch", async () => {
    const f = await setupTerms();
    const result = await readGooseyEscrow(runtime, input, { rpc: f.rpc, includeMarketTerms: true });
    expect(result.marketTerms).toMatchObject({ address: f.termsAddress, sealed: true, acceptanceBits: 3, manifestLength: 1000 });
    expect(result.marketTerms?.proposer).toEqual(result.resolution?.proposer);
    expect(result.orderBook?.reservesReconciled).toBe(true);
    expect(result.exchangeVerified).toBe(false);
    expect(result.finalizedSlot).toBe(12n);
    expect(f.getMultipleAccounts).toHaveBeenCalledTimes(2);
    const { book } = await deriveGooseyBookAddress(runtime.programAddress, f.p.market);
    expect(f.getMultipleAccounts).toHaveBeenNthCalledWith(2,
      [f.p.config, f.p.featherMint, f.p.market, seatsAddress, f.p.locator, f.p.vault, f.p.walletTokens,
        book, f.resolutionAddress, f.termsAddress],
      { encoding: "base64", commitment: "finalized", minContextSlot: 11n });
  });
  it("reports unsealed commitments as unsealed without inventing acceptance or manifest verification", async () => {
    const f = await setupTerms(); f.terms[237] = 1; f.terms[238] = 0; f.configureTerms();
    const result = await readGooseyEscrow(runtime, input, { rpc: f.rpc, includeMarketTerms: true });
    expect(result.marketTerms).toMatchObject({ sealed: false, acceptanceBits: 1 });
    expect(result.marketTerms).not.toHaveProperty("manifestVerified");
  });
  it.each(["missing", "owner", "short", "market", "reviewer", "acceptance", "sealed", "bump"] as const)(
    "fails closed on invalid required terms: %s", async mode => {
      const f = await setupTerms();
      if (mode === "market") f.terms[9] ^= 1;
      if (mode === "reviewer") f.terms[109] ^= 1;
      if (mode === "acceptance") f.terms[237] = 1;
      if (mode === "sealed") f.terms[238] = 2;
      if (mode === "bump") f.terms[239] ^= 1;
      f.configureTerms(mode === "missing" ? null : f.account(f.terms,
        mode === "owner" ? TOKEN_PROGRAM_ADDRESS : runtime.programAddress), mode === "short");
      await expect(readGooseyEscrow(runtime, input, { rpc: f.rpc, includeMarketTerms: true })).rejects.toThrow();
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
