import { AccountRole, address, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { sponsoredCancellationAllowlist } from "./sponsored-cancellation";

const PROGRAM = address("Vote111111111111111111111111111111111111111");
const WALLET = address("Stake11111111111111111111111111111111111111");
const MARKET = address("SysvarRent111111111111111111111111111111111");

function instruction(): Instruction {
  return { programAddress: PROGRAM, accounts: [
    { address: WALLET, role: AccountRole.READONLY_SIGNER },
    { address: MARKET, role: AccountRole.READONLY },
    { address: MARKET, role: AccountRole.WRITABLE },
  ] };
}

describe("sponsored cancellation allowlist", () => {
  it("permits one exact Goosey instruction and caps duplicate account privileges", () => {
    expect(sponsoredCancellationAllowlist(PROGRAM, [instruction()])).toEqual({
      instructionProgramAddresses: [PROGRAM],
      accounts: [
        { address: WALLET, maxRole: AccountRole.READONLY_SIGNER },
        { address: MARKET, maxRole: AccountRole.WRITABLE },
      ],
      maxInstructions: 1,
    });
  });

  it("rejects additional or foreign instructions", () => {
    expect(() => sponsoredCancellationAllowlist(PROGRAM, [instruction(), instruction()])).toThrow(/exactly one/);
    expect(() => sponsoredCancellationAllowlist(PROGRAM, [{ ...instruction(), programAddress: MARKET as Address }]))
      .toThrow(/exactly one/);
  });
});
