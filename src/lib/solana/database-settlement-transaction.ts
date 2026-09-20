import { AccountRole, address, type Instruction, type KeyPairSigner, type TransactionPartialSigner } from "@solana/kit";

import {
  buildAttestDatabaseSettlementInstruction,
  type DatabaseSettlementOutcome,
} from "@/lib/solana/database-settlement-client";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import {
  signSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

function allowlist(programAddress: SolanaRuntime["programAddress"], instruction: Instruction): SponsoredTransactionAllowlist {
  if (instruction.programAddress !== programAddress) throw new Error("Settlement attestation instruction program changed");
  const accounts = (instruction.accounts ?? []).map(account => {
    if ("lookupTableAddress" in account) throw new Error("Settlement attestation cannot use lookup tables");
    return Object.freeze({ address: address(account.address), maxRole: account.role as AccountRole });
  });
  if (new Set(accounts.map(account => account.address)).size !== accounts.length) {
    throw new Error("Settlement attestation instruction contains duplicate accounts");
  }
  return Object.freeze({
    instructionProgramAddresses: Object.freeze([programAddress]),
    accounts: Object.freeze(accounts),
    maxInstructions: 1,
  });
}

export async function prepareDatabaseSettlementAttestation(input: Readonly<{
  runtime: SolanaRuntime;
  authority: KeyPairSigner;
  sponsor: TransactionPartialSigner;
  databaseMarketDigest: Uint8Array;
  settlementDigest: Uint8Array;
  outcome: DatabaseSettlementOutcome;
  totalPositions: bigint;
  totalPayoutMilli: bigint;
  resolvedAt: bigint;
  signal?: AbortSignal;
}>) {
  const built = await buildAttestDatabaseSettlementInstruction({
    programAddress: input.runtime.programAddress,
    authority: input.authority,
    databaseMarketDigest: input.databaseMarketDigest,
    settlementDigest: input.settlementDigest,
    outcome: input.outcome,
    totalPositions: input.totalPositions,
    totalPayoutMilli: input.totalPayoutMilli,
    resolvedAt: input.resolvedAt,
  });
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: input.authority,
    sponsor: input.sponsor,
    instructions: [built.instruction],
    allowlist: allowlist(input.runtime.programAddress, built.instruction),
    signal: input.signal,
  });
  return Object.freeze({ ...built, signed });
}
