import { AccountRole, address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { sponsoredSeatAllowlist } from "./sponsored-seat";

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

describe("sponsored seat registration allowlist", () => {
  it("pins one Goosey instruction and merges duplicate account privileges", () => {
    expect(sponsoredSeatAllowlist(PROGRAM, [instruction()])).toEqual({
      instructionProgramAddresses: [PROGRAM],
      accounts: [
        { address: WALLET, maxRole: AccountRole.READONLY_SIGNER },
        { address: MARKET, maxRole: AccountRole.WRITABLE },
      ],
      maxInstructions: 1,
    });
  });

  it("rejects extra, foreign-program, and lookup-table instructions", () => {
    expect(() => sponsoredSeatAllowlist(PROGRAM, [])).toThrow(/exactly one/);
    expect(() => sponsoredSeatAllowlist(PROGRAM, [instruction(), instruction()])).toThrow(/exactly one/);
    expect(() => sponsoredSeatAllowlist(PROGRAM, [{ ...instruction(), programAddress: MARKET }])).toThrow(/exactly one/);
    expect(() => sponsoredSeatAllowlist(PROGRAM, [{ ...instruction(), accounts: [{
      address: MARKET, role: AccountRole.READONLY, lookupTableAddress: WALLET, addressIndex: 0,
    }] }])).toThrow(/lookup-table/);
  });
});
