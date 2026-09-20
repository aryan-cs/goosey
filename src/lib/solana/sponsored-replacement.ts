import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareOrderReplacement, type PrepareOrderReplacementInput } from "./prepare-replacement";
import { signSponsoredTransaction, type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist } from "./sponsored-transaction";

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

export function sponsoredReplacementAllowlist(programAddress: Address,
  instructions: readonly Instruction[]): SponsoredTransactionAllowlist {
  if (instructions.length !== 3 || instructions[0]?.programAddress !== COMPUTE_BUDGET
    || instructions[1]?.programAddress !== programAddress || instructions[2]?.programAddress !== programAddress) {
    throw new Error("Managed replacement requires compute-budget, cancel, and place instructions in exact order");
  }
  const roles = new Map<Address, AccountRole>();
  for (const instruction of instructions) for (const account of instruction.accounts ?? []) {
    if ("lookupTableAddress" in account) throw new Error("Managed replacement cannot use lookup-table accounts");
    const accountAddress = address(account.address);
    roles.set(accountAddress, (roles.get(accountAddress) === undefined
      ? account.role : roles.get(accountAddress)! | account.role) as AccountRole);
  }
  return Object.freeze({ instructionProgramAddresses: Object.freeze([COMPUTE_BUDGET, programAddress]),
    accounts: Object.freeze([...roles].map(([accountAddress, maxRole]) => Object.freeze({
      address: accountAddress, maxRole }))), maxInstructions: 3 });
}

export type PreparedSponsoredReplacement = Readonly<{
  signed: SignedSponsoredTransaction;
  market: Address;
  book: Address;
  orderId: bigint;
  replacementOrderId: bigint;
  outcome: "YES" | "NO";
  action: "BUY" | "SELL";
  price: bigint;
  quantity: bigint;
  expiresAt: bigint | null;
  expectedNonce: bigint;
  observedSlot: bigint;
  bookRevision: bigint;
}>;

export async function prepareSponsoredReplacement(input: Omit<PrepareOrderReplacementInput, "sender"> & Readonly<{
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
}>): Promise<PreparedSponsoredReplacement> {
  const prepared = await prepareOrderReplacement({ ...input, sender: input.participant });
  const signed = await signSponsoredTransaction({ runtime: input.runtime, participant: input.participant,
    sponsor: input.sponsor, instructions: prepared.instructions,
    allowlist: sponsoredReplacementAllowlist(input.runtime.programAddress, prepared.instructions), signal: input.signal });
  return Object.freeze({ signed, market: prepared.market, book: prepared.book, orderId: prepared.orderId,
    replacementOrderId: prepared.replacementOrderId, outcome: prepared.outcome, action: prepared.action,
    price: prepared.price, quantity: prepared.quantity, expiresAt: prepared.expiresAt,
    expectedNonce: prepared.expectedNonce, observedSlot: prepared.observedSlot,
    bookRevision: prepared.bookRevision });
}
