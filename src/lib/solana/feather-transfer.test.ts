import { generateKeyPairSigner } from "@solana/kit";
import { parseTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { buildFeatherTransfer, MAX_TOKEN_BASE_UNITS, parseFeatherAmount } from "./feather-transfer";

describe("exact feather token amounts", () => {
  it.each([["0.001", 1n], ["1", 1000n], ["10.2", 10200n], ["18446744073709551.615", MAX_TOKEN_BASE_UNITS]])("parses %s exactly", (text, amount) => {
    expect(parseFeatherAmount(text)).toBe(amount);
  });
  it.each(["0", "0.000", "-1", "+1", "1e3", "1.0001", "1.", ".1", " 1", "01", "NaN", "Infinity", "18446744073709551.616", "999999999999999999999999999999"])("rejects %s", (value) => {
    expect(() => parseFeatherAmount(value)).toThrow();
  });
});

describe("wallet-authorized SPL transfer instruction construction", () => {
  it("creates recipient ATA idempotently and binds exact amount, mint, source and owner", async () => {
    const [sender, recipient, mint] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const plan = await buildFeatherTransfer({ sender, recipient: recipient.address, mint: mint.address, amount: 1234n });
    const transfer = parseTransferCheckedInstruction(plan.instructions[1]!);
    expect(plan.source).not.toBe(plan.destination);
    expect(transfer.programAddress).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(transfer.data).toMatchObject({ amount: 1234n, decimals: 3 });
    expect(transfer.accounts.source.address).toBe(plan.source);
    expect(transfer.accounts.destination.address).toBe(plan.destination);
    expect(transfer.accounts.mint.address).toBe(mint.address);
    expect(transfer.accounts.authority.address).toBe(sender.address);
    expect(plan.instructions[0]!.data).toEqual(new Uint8Array([1]));
  });
  it("rejects self-transfer and invalid integer range before building", async () => {
    const sender = await generateKeyPairSigner();
    const recipient = await generateKeyPairSigner();
    const base = { sender, recipient: recipient.address, mint: recipient.address };
    for (const amount of [0n, -1n, MAX_TOKEN_BASE_UNITS + 1n]) {
      await expect(buildFeatherTransfer({ ...base, amount })).rejects.toThrow("positive u64");
    }
    await expect(buildFeatherTransfer({ ...base, amount: 1n, recipient: sender.address })).rejects.toThrow("different recipient");
  });
});
