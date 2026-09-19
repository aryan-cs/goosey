import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareOrder, type PrepareOrderInput } from "@/lib/solana/prepare-order";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

function maximumRole(left: AccountRole | undefined, right: AccountRole): AccountRole {
  return (left === undefined ? right : left | right) as AccountRole;
}

/** Builds an exact privilege ceiling from trusted server-built instructions.
 * The signer later rechecks every program, account, role, and signer object. */
export function sponsoredOrderAllowlist(
  programAddress: Address,
  instructions: readonly Instruction[],
): SponsoredTransactionAllowlist {
  if (instructions.length !== 2 || instructions[0]?.programAddress !== COMPUTE_BUDGET
    || instructions[1]?.programAddress !== programAddress) {
    throw new Error("Managed order instructions do not match the expected program sequence");
  }
  const roles = new Map<Address, AccountRole>();
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if ("lookupTableAddress" in account) throw new Error("Managed orders cannot use lookup-table accounts");
      const accountAddress = address(account.address);
      roles.set(accountAddress, maximumRole(roles.get(accountAddress), account.role));
    }
  }
  return Object.freeze({
    instructionProgramAddresses: Object.freeze([COMPUTE_BUDGET, programAddress]),
    accounts: Object.freeze([...roles].map(([accountAddress, maxRole]) => Object.freeze({
      address: accountAddress,
      maxRole,
    }))),
    maxInstructions: 2,
  });
}

export type PreparedSponsoredOrder = Readonly<{
  signed: SignedSponsoredTransaction;
  market: Address;
  book: Address;
  expectedNonce: bigint;
  observedSlot: bigint;
  bookRevision: bigint;
}>;

/** Validates finalized order state, then signs an exact sponsor-paid transaction.
 * It performs no persistence or submission; the ChainCommand worker must journal
 * the returned wire before sending it. */
export async function prepareSponsoredOrder(input: Omit<PrepareOrderInput, "sender"> & Readonly<{
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
}>): Promise<PreparedSponsoredOrder> {
  const prepared = await prepareOrder({ ...input, sender: input.participant });
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: input.participant,
    sponsor: input.sponsor,
    instructions: prepared.instructions,
    allowlist: sponsoredOrderAllowlist(input.runtime.programAddress, prepared.instructions),
    signal: input.signal,
  });
  return Object.freeze({
    signed,
    market: prepared.market,
    book: prepared.book,
    expectedNonce: prepared.expectedNonce,
    observedSlot: prepared.observedSlot,
    bookRevision: prepared.bookRevision,
  });
}
