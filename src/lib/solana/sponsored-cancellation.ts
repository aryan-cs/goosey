import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareCancelOrder, type PrepareCancelOrderInput } from "@/lib/solana/prepare-cancel";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

export function sponsoredCancellationAllowlist(
  programAddress: Address,
  instructions: readonly Instruction[],
): SponsoredTransactionAllowlist {
  if (instructions.length !== 1 || instructions[0]?.programAddress !== programAddress) {
    throw new Error("Managed cancellation requires exactly one Goosey program instruction");
  }
  const roles = new Map<Address, AccountRole>();
  for (const account of instructions[0].accounts ?? []) {
    if ("lookupTableAddress" in account) {
      throw new Error("Managed cancellation cannot use lookup-table accounts");
    }
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

export type PreparedSponsoredCancellation = Readonly<{
  signed: SignedSponsoredTransaction;
  market: Address;
  book: Address;
  orderId: bigint;
  expectedNonce: bigint;
  observedSlot: bigint;
  bookRevision: bigint;
}>;

/** Revalidates the exact resting order against finalized state, then signs one
 * sponsor-paid owner cancellation. Persistence and submission remain the
 * durable command dispatcher's responsibility. */
export async function prepareSponsoredCancellation(
  input: Omit<PrepareCancelOrderInput, "sender"> & Readonly<{
    participant: TransactionPartialSigner;
    sponsor: TransactionPartialSigner;
  }>,
): Promise<PreparedSponsoredCancellation> {
  const prepared = await prepareCancelOrder({ ...input, sender: input.participant });
  const instructions = prepared.message.instructions;
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: input.participant,
    sponsor: input.sponsor,
    instructions,
    allowlist: sponsoredCancellationAllowlist(input.runtime.programAddress, instructions),
    signal: input.signal,
  });
  return Object.freeze({
    signed,
    market: prepared.market,
    book: prepared.book,
    orderId: prepared.orderId,
    expectedNonce: prepared.expectedNonce,
    observedSlot: prepared.observedSlot,
    bookRevision: prepared.bookRevision,
  });
}
