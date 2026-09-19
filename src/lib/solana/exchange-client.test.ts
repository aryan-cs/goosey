import { createHash } from "node:crypto";
import { address, createNoopSigner, getSignersFromInstruction } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { describe, expect, it } from "vitest";
import { buildBookSetupInstruction, buildPlaceOrderInstruction, buildCancelOrderInstruction, buildCleanupOrderInstruction,
  type ChainOrderInput, type ChainOrderTarget } from "./exchange-client";

// Offline ABI fixtures only; deployment and economic execution are tested by the RPC suite.
const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const wallet = createNoopSigner(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"));
const seats = address("SysvarRent111111111111111111111111111111111");
const input = (): ChainOrderInput => ({ programAddress, marketId: 9007199254740993n, wallet, seats,
  expectedNonce: 9007199254740995n, price: 42n, quantity: 7n, outcome: "YES", action: "BUY",
  timeInForce: "GTC", selfTrade: "CANCEL_AGGRESSOR" });
const discriminator = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

describe("exchange instruction ABI", () => {
  it("encodes owner cancel with exact nonce, target and signer", async () => {
    const plan = await buildCancelOrderInstruction({ ...input(), target: { orderId: 9007199254740997n, side: "ASK", heapIndex: 1023 } });
    const bytes = Buffer.from(plan.instruction.data);
    expect(bytes.length).toBe(27); expect(bytes.subarray(0, 8)).toEqual(discriminator("cancel_order"));
    expect(bytes.readBigUInt64LE(8)).toBe(9007199254740997n); expect(bytes[16]).toBe(1);
    expect(bytes.readUInt16LE(17)).toBe(1023); expect(bytes.readBigUInt64LE(19)).toBe(input().expectedNonce);
    expect(plan.instruction.accounts.map(m => [m.address, m.role])).toEqual([
      [wallet.address, 2], [plan.config, 0], [plan.market, 0], [seats, 1], [plan.locator, 0], [plan.book, 1],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
  });
  it("encodes permissionless cleanup without client time, owner nonce or spend authority", async () => {
    const plan = await buildCleanupOrderInstruction({ ...input(), target: { orderId: 1n, side: "BID", heapIndex: 0 } });
    const bytes = Buffer.from(plan.instruction.data);
    expect(bytes.length).toBe(19); expect(bytes.subarray(0, 8)).toEqual(discriminator("cleanup_order"));
    expect(bytes.readBigUInt64LE(8)).toBe(1n); expect([...bytes.subarray(16)]).toEqual([0, 0, 0]);
    expect(plan.instruction.accounts.map(m => [m.address, m.role])).toEqual([
      [plan.config, 0], [plan.market, 0], [seats, 1], [plan.book, 1],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([]);
  });
  it("rejects invalid cancellation targets and exhausted owner nonces", async () => {
    const target = { orderId: 1n, side: "BID" as const, heapIndex: 0 };
    const patches = [{ orderId: 0n }, { orderId: 1n << 64n }, { orderId: 1 }, { side: "YES" },
      { heapIndex: -1 }, { heapIndex: 1024 }, { heapIndex: NaN }, { heapIndex: 0.5 }];
    for (const patch of patches) for (const build of [buildCancelOrderInstruction, buildCleanupOrderInstruction]) {
      await expect(build({ ...input(), target: { ...target, ...patch } as ChainOrderTarget })).rejects.toThrow();
    }
    await expect(buildCancelOrderInstruction({ ...input(), target, expectedNonce: (1n << 64n) - 1n })).rejects.toThrow("nonce");
  });
  it.each(["create", "grow", "finalize"] as const)("encodes %s book setup and canonical account privileges", async kind => {
    const plan = await buildBookSetupInstruction({ programAddress, marketId: input().marketId, admin: wallet,
      step: kind === "grow" ? { kind, expectedSize: 61440 } : { kind } });
    expect(Buffer.from(plan.instruction.data.slice(0, 8))).toEqual(discriminator(`${kind}_book`));
    expect(plan.instruction.data.length).toBe(kind === "grow" ? 12 : 8);
    if (kind === "grow") expect(Buffer.from(plan.instruction.data).readUInt32LE(8)).toBe(61440);
    expect(plan.instruction.accounts.map(m => [m.address, m.role])).toEqual([
      [wallet.address, 3], [plan.config, 0], [plan.market, 0], [plan.book, 1], [SYSTEM_PROGRAM_ADDRESS, 0],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
  });

  it.each([0, 10239, 10241, 69720, 71680, -1, NaN, Infinity, 10240.5])("rejects invalid draft size %s", async expectedSize => {
    await expect(buildBookSetupInstruction({ programAddress, marketId: 1n, admin: wallet,
      step: { kind: "grow", expectedSize } })).rejects.toThrow();
  });

  it("encodes exact u64 fields without Number conversion and minimal account privileges", async () => {
    const plan = await buildPlaceOrderInstruction(input());
    const bytes = Buffer.from(plan.instruction.data);
    expect(bytes.subarray(0, 8)).toEqual(discriminator("place_order"));
    expect(bytes.length).toBe(39);
    expect(bytes.readBigUInt64LE(8)).toBe(input().expectedNonce);
    expect(bytes.readBigUInt64LE(16)).toBe(42n);
    expect(bytes.readBigUInt64LE(24)).toBe(7n);
    expect([...bytes.subarray(32)]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(plan.instruction.accounts.map(m => [m.address, m.role])).toEqual([
      [wallet.address, 2], [plan.config, 0], [plan.market, 1], [seats, 1], [plan.locator, 0], [plan.vault, 0], [plan.book, 1],
    ]);
    expect(getSignersFromInstruction(plan.instruction)).toEqual([wallet]);
  });

  it("encodes NO SELL post-only with signed expiry option and maximum touch budget", async () => {
    const { instruction } = await buildPlaceOrderInstruction({ ...input(), outcome: "NO", action: "SELL",
      selfTrade: "CANCEL_BOTH", postOnly: true, expiresAt: (1n << 63n) - 1n, touches: 16 });
    const bytes = Buffer.from(instruction.data);
    expect(bytes.length).toBe(47);
    expect([...bytes.subarray(32, 38)]).toEqual([1, 1, 0, 2, 1, 1]);
    expect(bytes.readBigInt64LE(38)).toBe((1n << 63n) - 1n);
    expect(bytes[46]).toBe(16);
  });

  it.each(["IOC", "FOK"] as const)("encodes %s and disallows resting-only options", async timeInForce => {
    const { instruction } = await buildPlaceOrderInstruction({ ...input(), timeInForce, selfTrade: "CANCEL_RESTING" });
    expect(instruction.data[34]).toBe(timeInForce === "IOC" ? 1 : 2);
    expect(instruction.data[35]).toBe(1);
    for (const patch of [{ postOnly: true }, { expiresAt: 1n }]) {
      await expect(buildPlaceOrderInstruction({ ...input(), timeInForce, ...patch })).rejects.toThrow();
    }
  });

  it("rejects numeric overflow, malformed enums and noninteger budgets", async () => {
    const patches = [
      ...[-1n, 1n << 64n, (1n << 64n) - 1n, 1].map(expectedNonce => ({ expectedNonce })),
      ...[0n, -1n, 1000000n, 1].map(price => ({ price })),
      ...[0n, -1n, 10000001n, 1].map(quantity => ({ quantity })),
      ...[0n, -1n, 1n << 63n, 1].map(expiresAt => ({ expiresAt })),
      ...[-1, 17, 0.5, NaN, Infinity].map(touches => ({ touches })),
      { outcome: "toString" }, { action: "UNKNOWN" }, { timeInForce: "DAY" }, { selfTrade: "ALLOW" }, { postOnly: 1 },
    ];
    for (const patch of patches) await expect(buildPlaceOrderInstruction({ ...input(), ...patch } as ChainOrderInput)).rejects.toThrow();
  });

  it("binds books to the market and program", async () => {
    const first = await buildPlaceOrderInstruction(input());
    expect((await buildPlaceOrderInstruction(input())).book).toBe(first.book);
    expect((await buildPlaceOrderInstruction({ ...input(), marketId: input().marketId + 1n })).book).not.toBe(first.book);
    expect((await buildPlaceOrderInstruction({ ...input(), programAddress: wallet.address })).book).not.toBe(first.book);
  });
});
