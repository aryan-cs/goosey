import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareEscrowDeposit, type PrepareEscrowInput } from "@/lib/solana/prepare-escrow";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

/** Exact privilege ceiling for one trusted Goosey escrow deposit. */
export function sponsoredEscrowAllowlist(
  programAddress: Address,
  instructions: readonly Instruction[],
): SponsoredTransactionAllowlist {
  if (instructions.length !== 1 || instructions[0]?.programAddress !== programAddress) {
    throw new Error("Managed escrow deposit requires exactly one Goosey program instruction");
  }
  const roles = new Map<Address, AccountRole>();
  for (const account of instructions[0].accounts ?? []) {
    if ("lookupTableAddress" in account) throw new Error("Managed escrow deposits cannot use lookup-table accounts");
    const accountAddress = address(account.address);
    roles.set(accountAddress, (roles.get(accountAddress) === undefined
      ? account.role : roles.get(accountAddress)! | account.role) as AccountRole);
  }
  return Object.freeze({
    instructionProgramAddresses: Object.freeze([programAddress]),
    accounts: Object.freeze([...roles].map(([accountAddress, maxRole]) => Object.freeze({
      address: accountAddress,
      maxRole,
    }))),
    maxInstructions: 1,
  });
}

export type PreparedSponsoredEscrowDeposit = Readonly<{
  signed: SignedSponsoredTransaction;
  market: Address;
  seats: Address;
  vault: Address;
  walletTokens: Address;
  amount: bigint;
  expectedNonce: bigint;
  observedSlot: bigint;
  availableCash: bigint;
  walletTokenAmount: bigint;
}>;

/**
 * Revalidates finalized market escrow state, then signs one exact sponsor-paid
 * deposit. The participant still authorizes the feather transfer; the sponsor
 * only pays network fees. Persistence and submission belong to the command
 * dispatcher.
 */
export async function prepareSponsoredEscrowDeposit(
  input: Omit<PrepareEscrowInput, "sender"> & Readonly<{
    participant: TransactionPartialSigner;
    sponsor: TransactionPartialSigner;
  }>,
): Promise<PreparedSponsoredEscrowDeposit> {
  const { participant, sponsor, ...preparation } = input;
  const prepared = await prepareEscrowDeposit({ ...preparation, sender: participant });
  const instructions = prepared.message.instructions;
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant,
    sponsor,
    instructions,
    allowlist: sponsoredEscrowAllowlist(input.runtime.programAddress, instructions),
    signal: input.signal,
  });
  return Object.freeze({
    signed,
    market: prepared.market,
    seats: prepared.seats,
    vault: prepared.vault,
    walletTokens: prepared.walletTokens,
    amount: prepared.amount,
    expectedNonce: prepared.expectedNonce,
    observedSlot: prepared.observedSlot,
    availableCash: prepared.availableCash,
    walletTokenAmount: prepared.walletTokenAmount,
  });
}
