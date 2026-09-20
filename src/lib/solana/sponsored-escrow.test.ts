import { AccountRole, address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), sign: vi.fn() }));
vi.mock("@/lib/solana/prepare-escrow", () => ({ prepareEscrowDeposit: mocks.prepare }));
vi.mock("@/lib/solana/sponsored-transaction", () => ({ signSponsoredTransaction: mocks.sign }));

import { prepareSponsoredEscrowDeposit, sponsoredEscrowAllowlist } from "./sponsored-escrow";

const programAddress = address("CgEGAD3EGLm63YaSx58sRiNPQmmxg8RqvqcxE3xThX8Q");
const participant = { address: address("EnKKVxU5bicr61K8gNsUAAj6ibYDXLWUdXi6KKFyA47W"), signTransactions: vi.fn() };
const sponsor = { address: address("FNWvaKFgtcsc1jbfNyCKWBtT1oFqFSXwz8V8mheqYxED"), signTransactions: vi.fn() };
const market = address("Au1xe1zALe12gebNgwK4XbLyMqFtEFK861UZNDZSsCYN");
const instruction = { programAddress, accounts: [
  { address: participant.address, role: AccountRole.READONLY_SIGNER, signer: participant },
  { address: market, role: AccountRole.WRITABLE },
] } as const;
const runtime = { cluster: "localnet" as const, rpcUrl: "http://127.0.0.1:20999",
  programAddress, genesisHash: "AjRRXmyGBFhUtVWWp5xYXYKAP4Ha8vyTDRNVrkTVA2DE" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.prepare.mockResolvedValue({ message: { instructions: [instruction] }, market, seats: market,
    vault: market, walletTokens: participant.address, amount: 505n, expectedNonce: 0n,
    observedSlot: 10n, availableCash: 0n, walletTokenAmount: 10_000n });
  mocks.sign.mockResolvedValue({ signature: "signed" });
});

describe("sponsored escrow deposit", () => {
  it("allows only the exact single-program instruction privileges", () => {
    expect(sponsoredEscrowAllowlist(programAddress, [instruction])).toEqual({
      instructionProgramAddresses: [programAddress],
      accounts: [
        { address: participant.address, maxRole: AccountRole.READONLY_SIGNER },
        { address: market, maxRole: AccountRole.WRITABLE },
      ],
      maxInstructions: 1,
    });
    expect(() => sponsoredEscrowAllowlist(programAddress, [])).toThrow("exactly one");
    expect(() => sponsoredEscrowAllowlist(programAddress, [{ ...instruction, programAddress: sponsor.address }]))
      .toThrow("exactly one");
  });

  it("prepares with the participant and signs with a distinct sponsor", async () => {
    const result = await prepareSponsoredEscrowDeposit({ runtime, participant, sponsor, marketId: 7n, amount: 505n });
    expect(mocks.prepare).toHaveBeenCalledWith({ runtime, marketId: 7n, amount: 505n, sender: participant });
    expect(mocks.sign).toHaveBeenCalledWith(expect.objectContaining({
      runtime,
      participant,
      sponsor,
      instructions: [instruction],
      allowlist: expect.objectContaining({ maxInstructions: 1 }),
    }));
    expect(result).toMatchObject({ signed: { signature: "signed" }, amount: 505n,
      expectedNonce: 0n, availableCash: 0n, walletTokenAmount: 10_000n });
  });
});
