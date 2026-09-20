import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareMarketSeat, type PrepareMarketSeatInput } from "@/lib/solana/prepare-seat";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

/** Exact privilege ceiling for the single trusted register-seat instruction. */
export function sponsoredSeatAllowlist(
  programAddress: Address,
  instructions: readonly Instruction[],
): SponsoredTransactionAllowlist {
  if (instructions.length !== 1 || instructions[0]?.programAddress !== programAddress) {
    throw new Error("Managed seat registration requires exactly one Goosey program instruction");
  }
  const roles = new Map<Address, AccountRole>();
  for (const account of instructions[0].accounts ?? []) {
    if ("lookupTableAddress" in account) throw new Error("Managed seat registration cannot use lookup-table accounts");
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

export type PreparedSponsoredSeat = Readonly<{
  signed: SignedSponsoredTransaction;
  market: Address;
  seats: Address;
  enrollment: Address;
  locator: Address;
  observedSlot: bigint;
  enrollmentSlot: bigint;
  blockhashSlot: bigint;
}>;

/**
 * Revalidates finalized enrollment/market capacity, then signs one exact
 * sponsor-paid seat registration. Persistence and submission remain the
 * fenced ChainCommand dispatcher's responsibility.
 */
export async function prepareSponsoredSeatRegistration(
  input: Omit<PrepareMarketSeatInput, "sender" | "rentPayer"> & Readonly<{
    participant: TransactionPartialSigner;
    sponsor: TransactionPartialSigner;
  }>,
): Promise<PreparedSponsoredSeat> {
  const prepared = await prepareMarketSeat({ ...input, sender: input.participant, rentPayer: input.sponsor });
  const instructions = prepared.message.instructions;
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: input.participant,
    sponsor: input.sponsor,
    instructions,
    allowlist: sponsoredSeatAllowlist(input.runtime.programAddress, instructions),
    signal: input.signal,
  });
  return Object.freeze({
    signed,
    market: prepared.market,
    seats: prepared.seats,
    enrollment: prepared.enrollment,
    locator: prepared.locator,
    observedSlot: prepared.observedSlot,
    enrollmentSlot: prepared.enrollmentSlot,
    blockhashSlot: prepared.blockhashSlot,
  });
}
