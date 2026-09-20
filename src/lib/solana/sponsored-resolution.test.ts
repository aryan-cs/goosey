import { AccountRole, address, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { sponsoredResolutionAllowlist } from "./sponsored-resolution";

const PROGRAM = address("Vote111111111111111111111111111111111111111");
const REVIEWER = address("Stake11111111111111111111111111111111111111");
const MARKET = address("SysvarRent111111111111111111111111111111111");

function instruction(): Instruction {
  return { programAddress: PROGRAM, accounts: [
    { address: REVIEWER, role: AccountRole.READONLY_SIGNER },
    { address: MARKET, role: AccountRole.READONLY },
    { address: MARKET, role: AccountRole.WRITABLE },
  ] };
}

describe("sponsored resolution allowlist", () => {
  it("caps one Goosey instruction to its exact merged account privileges", () => {
    expect(sponsoredResolutionAllowlist(PROGRAM, [instruction()])).toEqual({
      instructionProgramAddresses: [PROGRAM],
      accounts: [
        { address: REVIEWER, maxRole: AccountRole.READONLY_SIGNER },
        { address: MARKET, maxRole: AccountRole.WRITABLE },
      ],
      maxInstructions: 1,
    });
  });

  it("rejects extra and foreign instructions", () => {
    expect(() => sponsoredResolutionAllowlist(PROGRAM, [instruction(), instruction()])).toThrow(/exactly one/);
    expect(() => sponsoredResolutionAllowlist(PROGRAM, [{ ...instruction(), programAddress: MARKET as Address }]))
      .toThrow(/exactly one/);
  });
});
