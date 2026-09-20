import { AccountRole, address, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { sponsoredReplacementAllowlist } from "./sponsored-replacement";

const PROGRAM = address("Vote111111111111111111111111111111111111111");
const WALLET = address("Stake11111111111111111111111111111111111111");
const ACCOUNT = address("SysvarRent111111111111111111111111111111111");
const BUDGET = address("ComputeBudget111111111111111111111111111111");
const program = (): Instruction => ({ programAddress: PROGRAM, accounts: [
  { address: WALLET, role: AccountRole.READONLY_SIGNER }, { address: ACCOUNT, role: AccountRole.WRITABLE }] });

describe("sponsored replacement allowlist", () => {
  it("allows only compute followed by exact cancel and place program instructions", () => {
    expect(sponsoredReplacementAllowlist(PROGRAM, [{ programAddress: BUDGET, accounts: [] }, program(), program()]))
      .toMatchObject({ instructionProgramAddresses: [BUDGET, PROGRAM], maxInstructions: 3 });
  });
  it("rejects split, reordered, or foreign instruction sequences", () => {
    expect(() => sponsoredReplacementAllowlist(PROGRAM, [program(), program()])).toThrow(/exact order/);
    expect(() => sponsoredReplacementAllowlist(PROGRAM, [{ programAddress: BUDGET, accounts: [] }, program(),
      { ...program(), programAddress: ACCOUNT as Address }])).toThrow(/exact order/);
  });
});
