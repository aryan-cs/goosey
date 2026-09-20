import {
  AccountRole,
  address,
  createSolanaRpc,
  generateKeyPairSigner,
  type Address,
  type Instruction,
  type TransactionPartialSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";

import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { buildCreateMarketInstructions, GOOSEY_SEATS_ACCOUNT_SPACE } from "@/lib/solana/escrow-client";
import { signSponsoredTransaction, type SponsoredTransactionAllowlist } from "@/lib/solana/sponsored-transaction";
import type { SolanaRuntime } from "@/lib/solana/runtime";

function allowlist(programAddress: Address, instructions: readonly Instruction[]): SponsoredTransactionAllowlist {
  if (instructions.length !== 2 || instructions[0]?.programAddress !== SYSTEM_PROGRAM_ADDRESS
    || instructions[1]?.programAddress !== programAddress) {
    throw new Error("Managed market provisioning requires exact System/CreateMarket instructions");
  }
  const roles = new Map<Address, AccountRole>();
  for (const instruction of instructions) {
    for (const account of instruction.accounts ?? []) {
      if ("lookupTableAddress" in account) throw new Error("Market provisioning cannot use lookup tables");
      const accountAddress = address(account.address);
      const previous = roles.get(accountAddress);
      roles.set(accountAddress, (previous === undefined ? account.role : previous | account.role) as AccountRole);
    }
  }
  return Object.freeze({
    instructionProgramAddresses: Object.freeze([SYSTEM_PROGRAM_ADDRESS, programAddress]),
    requiredInstructionProgramAddresses: Object.freeze([programAddress]),
    accounts: Object.freeze([...roles].map(([accountAddress, maxRole]) => Object.freeze({ address: accountAddress, maxRole }))),
    maxInstructions: 2,
  });
}

/** Builds and signs the one atomic Seats allocation + create_market transaction. */
export async function prepareSponsoredMarketProvisioning(input: Readonly<{
  runtime: SolanaRuntime;
  authority: TransactionPartialSigner;
  marketId: bigint;
  payoutMilli: bigint;
  feeBps: number;
  closesAt: bigint;
  resolvesAt: bigint;
  signal?: AbortSignal;
}>) {
  const signal = input.signal ?? AbortSignal.timeout(20_000);
  const configuration = await readGooseyConfiguration(input.runtime, signal);
  if (configuration.admin !== input.authority.address) {
    throw new Error("Configured market authority is not the finalized Goosey program admin");
  }
  const rpc = createSolanaRpc(input.runtime.rpcUrl);
  const rent = await rpc.getMinimumBalanceForRentExemption(GOOSEY_SEATS_ACCOUNT_SPACE, {
    commitment: "finalized",
  }).send({ abortSignal: signal });
  if (typeof rent !== "bigint" || rent <= 0n) throw new Error("Invalid finalized Seats rent quote");
  const seats = await generateKeyPairSigner();
  const built = await buildCreateMarketInstructions({
    programAddress: input.runtime.programAddress,
    marketId: input.marketId,
    admin: input.authority,
    seats,
    seatsPayer: input.authority,
    seatsRentLamports: rent,
    payoutMilli: input.payoutMilli,
    feeBps: input.feeBps,
    closesAt: input.closesAt,
    resolvesAt: input.resolvesAt,
  });
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: seats,
    sponsor: input.authority,
    instructions: built.instructions,
    allowlist: allowlist(input.runtime.programAddress, built.instructions),
    signal,
  });
  return Object.freeze({ signed, market: built.market, seats: built.seats, configurationSlot: configuration.finalizedSlot });
}
