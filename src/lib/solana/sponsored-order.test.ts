import { AccountRole, address, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";

import { sponsoredOrderAllowlist } from "./sponsored-order";

const PROGRAM = address("Vote111111111111111111111111111111111111111");
const WALLET = address("Stake11111111111111111111111111111111111111");
const MARKET = address("SysvarRent111111111111111111111111111111111");
const COMPUTE = address("ComputeBudget111111111111111111111111111111");

function instructions(): readonly Instruction[] {
  return [
    { programAddress: COMPUTE, accounts: [], data: new Uint8Array([2, 0, 0, 0, 0]) },
    { programAddress: PROGRAM, accounts: [
      { address: WALLET, role: AccountRole.READONLY_SIGNER },
      { address: MARKET, role: AccountRole.READONLY },
      { address: MARKET, role: AccountRole.WRITABLE },
    ] },
  ];
}

describe("sponsored order allowlist", () => {
  it("deduplicates accounts using their maximum observed privileges", () => {
    expect(sponsoredOrderAllowlist(PROGRAM, instructions())).toEqual({
      instructionProgramAddresses: [COMPUTE, PROGRAM],
      accounts: [
        { address: WALLET, maxRole: AccountRole.READONLY_SIGNER },
        { address: MARKET, maxRole: AccountRole.WRITABLE },
      ],
      maxInstructions: 2,
    });
  });

  it("rejects any unexpected instruction sequence", () => {
    expect(() => sponsoredOrderAllowlist(PROGRAM, instructions().slice(1))).toThrow(/sequence/);
    expect(() => sponsoredOrderAllowlist(PROGRAM, [instructions()[0], {
      ...instructions()[1], programAddress: MARKET as Address,
    }])).toThrow(/sequence/);
  });
});
