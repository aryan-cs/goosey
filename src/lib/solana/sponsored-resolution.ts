import { AccountRole, address, type Address, type Instruction, type TransactionPartialSigner } from "@solana/kit";

import { prepareResolutionProposal, prepareResolutionReview } from "@/lib/solana/prepare-market-review";
import { prepareResolutionClaim } from "@/lib/solana/prepare-resolution-claim";
import { prepareResolutionClose, prepareResolutionFinalize } from "@/lib/solana/prepare-resolution-keeper";
import type { ResolutionOutcome } from "@/lib/solana/resolution-client";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import {
  signSponsoredTransaction,
  type SignedSponsoredTransaction,
  type SponsoredTransactionAllowlist,
} from "@/lib/solana/sponsored-transaction";

export type ManagedResolutionOperation =
  | "CLOSE_RESOLUTION"
  | "PROPOSE_RESOLUTION"
  | "APPROVE_RESOLUTION"
  | "CLAIM_RESOLUTION"
  | "FINALIZE_RESOLUTION";

export type ManagedResolutionFingerprint = Readonly<{
  sequence: bigint;
  outcome: ResolutionOutcome;
  reasonDigestSha256: Uint8Array;
  evidenceDigestSha256: Uint8Array;
}>;

export type PrepareSponsoredResolutionInput = Readonly<{
  runtime: SolanaRuntime;
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
  marketId: bigint;
  operation: ManagedResolutionOperation;
  fingerprint?: ManagedResolutionFingerprint;
  signal?: AbortSignal;
}>;

export type PreparedSponsoredResolution = Readonly<{
  operation: ManagedResolutionOperation;
  signed: SignedSponsoredTransaction;
  market: Address;
  resolution: Address;
  observedSlot: bigint;
  proposal?: Address;
  receipt?: Address;
  seatIndex?: number;
}>;

/** Builds the smallest possible privilege ceiling around one trusted resolution instruction. */
export function sponsoredResolutionAllowlist(
  programAddress: Address,
  instructions: readonly Instruction[],
): SponsoredTransactionAllowlist {
  if (instructions.length !== 1 || instructions[0]?.programAddress !== programAddress) {
    throw new Error("Managed resolution requires exactly one Goosey program instruction");
  }
  const roles = new Map<Address, AccountRole>();
  for (const account of instructions[0].accounts ?? []) {
    if ("lookupTableAddress" in account) throw new Error("Managed resolution cannot use lookup-table accounts");
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

function requiredFingerprint(input: PrepareSponsoredResolutionInput): ManagedResolutionFingerprint {
  if (!input.fingerprint) throw new Error(`${input.operation} requires an immutable resolution fingerprint`);
  return input.fingerprint;
}

/**
 * Reuses the strict finalized-state preparers, then replaces their participant-paid
 * message lifetime with an exact sponsor-paid transaction. It never persists or sends.
 */
export async function prepareSponsoredResolution(
  input: PrepareSponsoredResolutionInput,
): Promise<PreparedSponsoredResolution> {
  const common = { runtime: input.runtime, marketId: input.marketId, signal: input.signal };
  const prepared = input.operation === "CLOSE_RESOLUTION"
    ? await prepareResolutionClose({ ...common, keeper: input.participant })
    : input.operation === "FINALIZE_RESOLUTION"
      ? await prepareResolutionFinalize({ ...common, keeper: input.participant })
      : input.operation === "CLAIM_RESOLUTION"
        ? await prepareResolutionClaim({ ...common, payer: input.participant, targetWallet: input.participant.address })
        : input.operation === "PROPOSE_RESOLUTION"
          ? await prepareResolutionProposal({
              ...common,
              proposer: input.participant,
              expectedNextSequence: requiredFingerprint(input).sequence,
              outcome: requiredFingerprint(input).outcome,
              reasonDigestSha256: requiredFingerprint(input).reasonDigestSha256,
              evidenceDigestSha256: requiredFingerprint(input).evidenceDigestSha256,
            })
          : await prepareResolutionReview({
              ...common,
              approver: input.participant,
              expected: {
                sequence: requiredFingerprint(input).sequence,
                outcome: requiredFingerprint(input).outcome,
                reasonDigest: requiredFingerprint(input).reasonDigestSha256,
                evidenceDigest: requiredFingerprint(input).evidenceDigestSha256,
              },
              decision: { decision: "APPROVE" },
            });
  const instructions = prepared.message.instructions;
  const signed = await signSponsoredTransaction({
    runtime: input.runtime,
    participant: input.participant,
    sponsor: input.sponsor,
    instructions,
    allowlist: sponsoredResolutionAllowlist(input.runtime.programAddress, instructions),
    signal: input.signal,
  });
  return Object.freeze({
    operation: input.operation,
    signed,
    market: prepared.market,
    resolution: prepared.resolution,
    observedSlot: prepared.observedSlot,
    ...("proposal" in prepared ? { proposal: prepared.proposal } : {}),
    ...("receipt" in prepared ? { receipt: prepared.receipt, seatIndex: prepared.seatIndex } : {}),
  });
}
