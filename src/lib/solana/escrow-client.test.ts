import { address, createNoopSigner, getSignersFromInstruction, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS, ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { parseCreateAccountInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { GOOSEY_SEATS_ACCOUNT_SPACE, buildCreateMarketInstructions, buildRegisterSeatInstruction,
  buildDepositInstruction, buildWithdrawInstruction, deriveGooseySeatAddresses, deriveGooseyMarketAddresses } from "./escrow-client";

// Offline construction fixtures, not funded wallets or proof of chain execution.
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = createNoopSigner(TOKEN_PROGRAM_ADDRESS);
const admin = createNoopSigner(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
const seats = createNoopSigner(address("SysvarRent111111111111111111111111111111111"));
const marketId = 9_007_199_254_740_993n;
const max = (1n << 64n) - 1n;
const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const createInput = () => ({ programAddress, marketId, admin, seats, seatsRentLamports: 1_234_567n,
  payoutMilli: 100_000n, feeBps: 250, closesAt: 2_000_000_000n, resolvesAt: 2_000_000_001n });
const walletInput = () => ({ programAddress, marketId, wallet, seats: seats.address });

describe("escrow client instruction contract", () => {
  it("derives fixed PDA/ATA vectors with exact large market ID", async () => {
    const plan = await deriveGooseySeatAddresses({ programAddress, marketId, wallet: wallet.address });
    expect(plan).toMatchObject({ market: "6huj3hVD3matBetXZoW6GTfpP6wPrjDXX2RcvKv1o7wY", marketBump: 252,
      vault: "G6DLBwAJRJEuwMqrrZk3Dx4t5kSif6KxxanCCamnNR6K", locator: "6Hi3nrVFT1onEaPQeajczDPf4jt3kDV3aexfXrNSSy5w", locatorBump: 255,
      enrollment: "EKNbyr5Ar3RG72Bx3kK4krLtWodVzXZo6cbT5XT3JSRk", walletTokens: "9eKU3TXz9RAFVT12xEDtcFsFtXKEpXJRxUMCfKEgr8Hj" });
    expect(await deriveGooseySeatAddresses({ programAddress, marketId, wallet: wallet.address })).toEqual(plan);
    const next = await deriveGooseySeatAddresses({ programAddress, marketId: marketId + 1n, wallet: wallet.address });
    expect(next.market).not.toBe(plan.market);
    expect(next.vault).not.toBe(plan.vault);
    expect(next.locator).not.toBe(plan.locator);
    expect(next.walletTokens).toBe(plan.walletTokens);
    const otherWallet = await deriveGooseySeatAddresses({ programAddress, marketId, wallet: admin.address });
    expect(otherWallet.market).toBe(plan.market);
    expect(otherWallet.locator).not.toBe(plan.locator);
    expect(otherWallet.enrollment).not.toBe(plan.enrollment);
    expect((await deriveGooseyMarketAddresses({ programAddress: admin.address, marketId })).market).not.toBe(plan.market);
  });

  it("allocates exactly 32816 bytes owned by caller program then initializes, with correct distinct signers", async () => {
    const plan = await buildCreateMarketInstructions({ ...createInput(), seatsPayer: wallet });
    expect(plan.instructions).toEqual([plan.createSeatsInstruction, plan.instruction]);
    const parsed = parseCreateAccountInstruction(plan.createSeatsInstruction);
    expect(parsed.programAddress).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(parsed.data).toMatchObject({ lamports: 1_234_567n, space: 32_816n, programAddress });
    expect(GOOSEY_SEATS_ACCOUNT_SPACE).toBe(32_816n);
    expect(parsed.accounts.payer).toMatchObject({ address: wallet.address, role: 3, signer: wallet });
    expect(parsed.accounts.newAccount).toMatchObject({ address: seats.address, role: 3, signer: seats });
    expect(getSignersFromInstruction(plan.createSeatsInstruction)).toEqual([wallet, seats]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([admin]);
    expect(plan.instruction.accounts.map((meta) => [meta.address, meta.role])).toEqual([
      [admin.address, 3], [plan.config, 0], [plan.market, 1], [seats.address, 1], [plan.featherMint, 0], [plan.vault, 1],
      [TOKEN_PROGRAM_ADDRESS, 0], [ASSOCIATED_TOKEN_PROGRAM_ADDRESS, 0], [SYSTEM_PROGRAM_ADDRESS, 0],
    ]);
    const defaultPayer = await buildCreateMarketInstructions(createInput());
    expect(getSignersFromInstruction(defaultPayer.createSeatsInstruction)).toEqual([admin, seats]);
  });

  it("encodes create_market discriminator and all Borsh fields at exact offsets", async () => {
    const { instruction } = await buildCreateMarketInstructions(createInput());
    const bytes = instruction.data;
    expect(bytes.length).toBe(42);
    expect(hex(bytes.slice(0, 8))).toBe("67e261ebc8bcfbfe");
    expect(hex(bytes.slice(8, 16))).toBe("0100000000002000");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(16, true)).toBe(100_000n);
    expect(view.getUint16(24, true)).toBe(250);
    expect(view.getBigInt64(26, true)).toBe(2_000_000_000n);
    expect(view.getBigInt64(34, true)).toBe(2_000_000_001n);
    const boundary = await buildCreateMarketInstructions({ ...createInput(), marketId: max, payoutMilli: 1_000_000n,
      feeBps: 10_000, closesAt: (1n << 63n) - 1n, resolvesAt: (1n << 63n) - 1n });
    expect(hex(boundary.instruction.data.slice(8, 16))).toBe("ffffffffffffffff");
    expect(hex(boundary.instruction.data.slice(26))).toBe("ffffffffffffff7fffffffffffffff7f");
    await expect(buildCreateMarketInstructions({ ...createInput(), marketId: 0n, payoutMilli: 2n, feeBps: 0 })).resolves.toBeDefined();
  });

  it("registers the signing wallet as account payer, no invented seat index or nonce", async () => {
    const plan = await buildRegisterSeatInstruction(walletInput());
    expect(hex(plan.instruction.data)).toBe("aad7f54006fc2974");
    expect(plan.instruction.accounts.map((meta) => [meta.address, meta.role])).toEqual([
      [wallet.address, 3], [plan.config, 0], [plan.enrollment, 0], [plan.market, 0], [seats.address, 1], [plan.locator, 1], [SYSTEM_PROGRAM_ADDRESS, 0],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
  });

  it.each([["deposit", buildDepositInstruction, "f223c68952e1f2b6"], ["withdraw", buildWithdrawInstruction, "b712469c946da122"]] as const)(
    "%s binds owner ATA/vault and exact nonce with readonly wallet signer", async (_name, build, discriminator) => {
      const plan = await build({ ...walletInput(), amount: max, expectedNonce: max - 1n });
      expect(hex(plan.instruction.data)).toBe(discriminator + "fffffffffffffffffeffffffffffffff");
      expect(plan.instruction.accounts.map((meta) => [meta.address, meta.role])).toEqual([
        [wallet.address, 2], [plan.config, 0], [plan.market, 1], [seats.address, 1], [plan.locator, 0],
        [plan.featherMint, 0], [plan.walletTokens, 1], [plan.vault, 1], [TOKEN_PROGRAM_ADDRESS, 0],
      ]);
      expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
      const first = await build({ ...walletInput(), amount: 1n, expectedNonce: 0n });
      expect(hex(first.instruction.data.slice(16))).toBe("0000000000000000");
    });

  it("rejects malformed amounts/nonce including nonce that cannot increment", async () => {
    for (const build of [buildDepositInstruction, buildWithdrawInstruction]) {
      for (const amount of [0n, -1n, max + 1n, 1 as unknown as bigint]) {
        await expect(build({ ...walletInput(), amount, expectedNonce: 0n })).rejects.toThrow("Amount");
      }
      for (const expectedNonce of [-1n, max, max + 1n, 0 as unknown as bigint]) {
        await expect(build({ ...walletInput(), amount: 1n, expectedNonce })).rejects.toThrow("Nonce");
      }
    }
  });

  it("validates supplied rent, payout, fee and signed time boundaries without inventing rent or chain time", async () => {
    const invalid = [
      ...[0n, -1n, max + 1n, 123 as unknown as bigint].map((seatsRentLamports) => ({ seatsRentLamports })),
      ...[1n, 1_000_001n, 2 as unknown as bigint].map((payoutMilli) => ({ payoutMilli })),
      ...[-1, 10_001, 0.5, NaN, Infinity].map((feeBps) => ({ feeBps })),
      ...[-1n, max + 1n, 0 as unknown as bigint].map((marketId) => ({ marketId })),
      ...[0n, -1n, 1n << 63n, 1 as unknown as bigint].map((closesAt) => ({ closesAt })),
      ...[0n, 1n << 63n, 1 as unknown as bigint, 1_999_999_999n].map((resolvesAt) => ({ resolvesAt })),
    ];
    for (const patch of invalid) await expect(buildCreateMarketInstructions({ ...createInput(), ...patch })).rejects.toThrow();
  });

  it("rejects non-signers, invalid addresses, and reuse of payer/admin as the new Seats account", async () => {
    for (const existing of [admin, wallet]) {
      await expect(buildCreateMarketInstructions({ ...createInput(), seats: existing, seatsPayer: wallet })).rejects.toThrow("separate new account");
    }
    await expect(buildCreateMarketInstructions({ ...createInput(), seats: { address: seats.address } as TransactionSigner })).rejects.toThrow();
    await expect(buildRegisterSeatInstruction({ ...walletInput(), wallet: { address: wallet.address } as TransactionSigner })).rejects.toThrow();
    await expect(buildWithdrawInstruction({ ...walletInput(), seats: "bad" as typeof seats.address, amount: 1n, expectedNonce: 0n })).rejects.toThrow();
    await expect(deriveGooseyMarketAddresses({ programAddress: "bad" as typeof programAddress, marketId })).rejects.toThrow();
  });
});
