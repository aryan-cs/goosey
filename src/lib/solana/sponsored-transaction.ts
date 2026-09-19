import { createHash } from "node:crypto";

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  assertIsTransactionPartialSigner,
  blockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getSignersFromTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  verifySignature,
  type Address,
  type Instruction,
  type Transaction,
  type TransactionPartialSigner,
} from "@solana/kit";

import { probeSolanaRuntime, resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

const MAX_U64 = (1n << 64n) - 1n;
const DEFAULT_MAX_INSTRUCTIONS = 16;
const MAX_INSTRUCTIONS = 32;
const MAX_ACCOUNTS = 256;

export type SponsoredTransactionAllowlist = Readonly<{
  /** Every invoked program must appear here. The pinned Goosey program is mandatory. */
  instructionProgramAddresses: readonly Address[];
  /** Every account and its maximum permitted signer/write privileges. */
  accounts: readonly Readonly<{ address: Address; maxRole: AccountRole }>[];
  maxInstructions?: number;
}>;

export type SignedSponsoredTransaction = Readonly<{
  version: 1;
  cluster: "localnet" | "devnet";
  genesisHash: string;
  programAddress: Address;
  participantAddress: Address;
  sponsorAddress: Address;
  signature: string;
  signedWireBase64: ReturnType<typeof getBase64EncodedWireTransaction>;
  messageSha256: string;
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
}>;

type SponsoredRpc = Pick<ReturnType<typeof createSolanaRpc>,
  "getGenesisHash" | "getAccountInfo" | "getLatestBlockhash">;

function pinnedRuntime(runtime: SolanaRuntime): SolanaRuntime {
  const captured = {
    cluster: runtime.cluster,
    rpcUrl: runtime.rpcUrl,
    programAddress: address(runtime.programAddress),
    genesisHash: runtime.genesisHash,
  } as const;
  const resolved = resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: captured.cluster,
    GOOSEY_SOLANA_RPC_URL: captured.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: captured.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: captured.genesisHash,
  });
  if (resolved.cluster !== captured.cluster || resolved.genesisHash !== captured.genesisHash
    || resolved.programAddress !== captured.programAddress) {
    throw new Error("Sponsored transaction runtime changed during validation");
  }
  return resolved;
}

function exactAddressSet(values: readonly Address[], name: string): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ACCOUNTS) {
    throw new Error(`${name} must contain between 1 and ${MAX_ACCOUNTS} addresses`);
  }
  const result = new Set(values.map(value => address(value)));
  if (result.size !== values.length) throw new Error(`${name} must not contain duplicate addresses`);
  return result;
}

function isSignerRole(role: AccountRole): boolean {
  return role === AccountRole.READONLY_SIGNER || role === AccountRole.WRITABLE_SIGNER;
}

function roleFits(actual: AccountRole, maximum: AccountRole): boolean {
  return (actual | maximum) === maximum;
}

function assertSafePartialSigner(signer: TransactionPartialSigner): void {
  assertIsTransactionPartialSigner(signer);
  if ("modifyAndSignTransactions" in signer || "signAndSendTransactions" in signer) {
    throw new Error("Sponsored custody requires non-modifying, non-sending partial signers");
  }
}

function captureInstructions(input: {
  instructions: readonly Instruction[];
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
  runtime: SolanaRuntime;
  allowlist: SponsoredTransactionAllowlist;
}): readonly Instruction[] {
  const maximum = input.allowlist.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_INSTRUCTIONS) {
    throw new Error(`Sponsored transaction maxInstructions must be between 1 and ${MAX_INSTRUCTIONS}`);
  }
  if (!Array.isArray(input.instructions) || input.instructions.length === 0 || input.instructions.length > maximum) {
    throw new Error(`Sponsored transaction requires between 1 and ${maximum} instructions`);
  }
  const programs = exactAddressSet(input.allowlist.instructionProgramAddresses, "Instruction program allowlist");
  if (!Array.isArray(input.allowlist.accounts) || input.allowlist.accounts.length === 0
    || input.allowlist.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`Instruction account allowlist must contain between 1 and ${MAX_ACCOUNTS} entries`);
  }
  const accounts = new Map<string, AccountRole>();
  for (const allowance of [...input.allowlist.accounts]) {
    const accountAddress = address(allowance.address);
    if (!Number.isInteger(allowance.maxRole) || allowance.maxRole < AccountRole.READONLY
      || allowance.maxRole > AccountRole.WRITABLE_SIGNER) throw new Error("Invalid account allowlist role");
    if (accounts.has(accountAddress)) throw new Error("Instruction account allowlist must not contain duplicates");
    accounts.set(accountAddress, allowance.maxRole);
  }
  if (!programs.has(input.runtime.programAddress)) {
    throw new Error("Instruction program allowlist must include the pinned Goosey program");
  }

  let invokesGoosey = false;
  let participantRequired = false;
  let accountCount = 0;
  const captured = input.instructions.map((instruction, instructionIndex) => {
    const programAddress = address(instruction.programAddress);
    if (!programs.has(programAddress)) {
      throw new Error(`Instruction ${instructionIndex} invokes a program outside the allowlist`);
    }
    invokesGoosey ||= programAddress === input.runtime.programAddress;
    const sourceAccounts = instruction.accounts ?? [];
    const capturedAccounts = sourceAccounts.map((account: (typeof sourceAccounts)[number], accountIndex: number) => {
      if ("lookupTableAddress" in account) {
        throw new Error(`Instruction ${instructionIndex} account ${accountIndex} uses an unsupported lookup table`);
      }
      const accountAddress = address(account.address);
      const maximumRole = accounts.get(accountAddress);
      if (maximumRole === undefined || !roleFits(account.role, maximumRole))
        throw new Error(`Instruction ${instructionIndex} uses account privileges outside the allowlist`);
      accountCount += 1;
      if (!Object.values(AccountRole).includes(account.role)) {
        throw new Error(`Instruction ${instructionIndex} has an invalid account role`);
      }
      const signer = "signer" in account ? account.signer : undefined;
      if (!isSignerRole(account.role)) {
        if (signer !== undefined) throw new Error(`Instruction ${instructionIndex} has a signer on a non-signer account`);
        return Object.freeze({ address: accountAddress, role: account.role });
      }
      if (accountAddress !== input.participant.address && accountAddress !== input.sponsor.address) {
        throw new Error(`Instruction ${instructionIndex} requires an unauthorized signer`);
      }
      if (!signer || signer.address !== accountAddress) {
        throw new Error(`Instruction ${instructionIndex} is missing its exact app-managed signer`);
      }
      assertSafePartialSigner(signer);
      const expected = accountAddress === input.participant.address ? input.participant : input.sponsor;
      if (signer !== expected) throw new Error(`Instruction ${instructionIndex} substituted an untrusted signer object`);
      participantRequired ||= accountAddress === input.participant.address;
      return Object.freeze({ address: accountAddress, role: account.role, signer: expected });
    });
    const data = instruction.data === undefined ? undefined : new Uint8Array(instruction.data);
    return Object.freeze({
      programAddress,
      accounts: Object.freeze(capturedAccounts),
      ...(data === undefined ? {} : { data }),
    }) satisfies Instruction;
  });
  if (accountCount > MAX_ACCOUNTS) throw new Error(`Sponsored transaction exceeds ${MAX_ACCOUNTS} account metas`);
  if (!invokesGoosey) throw new Error("Sponsored transaction must invoke the pinned Goosey program");
  if (!participantRequired) throw new Error("Sponsored transaction must require the app-managed participant signature");
  return Object.freeze(captured);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256Base64Url(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

async function verifyExactSignatures(
  transaction: Transaction,
  expectedMessage: Uint8Array,
  participantAddress: Address,
  sponsorAddress: Address,
): Promise<void> {
  if (!sameBytes(new Uint8Array(transaction.messageBytes), expectedMessage)) {
    throw new Error("A signer altered the frozen sponsored transaction message");
  }
  const expectedSigners = [participantAddress, sponsorAddress].sort();
  const actualSigners = Object.keys(transaction.signatures).sort();
  if (actualSigners.length !== 2 || actualSigners.join(",") !== expectedSigners.join(",")) {
    throw new Error("Sponsored transaction has an unexpected signer set");
  }
  assertIsFullySignedTransaction(transaction);
  for (const signerAddress of expectedSigners) {
    const signer = address(signerAddress);
    const signature = transaction.signatures[signer];
    if (!signature || !await verifySignature(await getPublicKeyFromAddress(signer), signature, transaction.messageBytes)) {
      throw new Error("Sponsored transaction has an invalid signature");
    }
  }
}

/**
 * Builds and signs one exact v0 transaction with an app-managed participant and
 * a distinct sponsor fee payer. Only partial signers are accepted, so this
 * function cannot delegate sending or permit a signer to rewrite the message.
 * It performs no submission, persistence, logging, or SQL accounting.
 */
export async function signSponsoredTransaction(input: {
  runtime: SolanaRuntime;
  participant: TransactionPartialSigner;
  sponsor: TransactionPartialSigner;
  instructions: readonly Instruction[];
  allowlist: SponsoredTransactionAllowlist;
  signal?: AbortSignal;
  rpc?: SponsoredRpc;
}): Promise<SignedSponsoredTransaction> {
  const participant = input.participant, sponsor = input.sponsor;
  assertSafePartialSigner(participant);
  assertSafePartialSigner(sponsor);
  const participantAddress = address(participant.address);
  const sponsorAddress = address(sponsor.address);
  if (participantAddress === sponsorAddress) throw new Error("Participant and sponsor must be distinct Solana signers");

  const runtime = pinnedRuntime(input.runtime);
  const instructions = captureInstructions({ ...input, participant, sponsor, runtime });
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const rpc = input.rpc ?? createSolanaRpc(runtime.rpcUrl);
  signal.throwIfAborted();
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const minimumSlot = BigInt(probe.finalizedSlot);
  if (minimumSlot < 0n || minimumSlot > MAX_U64) throw new Error("Invalid finalized deployment slot");
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: minimumSlot })
    .send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < minimumSlot || latest.context.slot > MAX_U64
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n
    || latest.value.lastValidBlockHeight > MAX_U64) {
    throw new Error("Invalid finalized lifetime for sponsored transaction");
  }
  const lifetime = {
    blockhash: blockhash(latest.value.blockhash),
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
  };
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed before sponsored signing");
  }
  if (participant.address !== participantAddress || sponsor.address !== sponsorAddress) {
    throw new Error("Sponsored transaction signer identity changed before signing");
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    value => setTransactionMessageFeePayerSigner(sponsor, value),
    value => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    value => appendTransactionMessageInstructions(instructions, value),
  );
  const messageSigners = getSignersFromTransactionMessage(message).map(signer => signer.address).sort();
  if (messageSigners.join(",") !== [participantAddress, sponsorAddress].sort().join(",")) {
    throw new Error("Sponsored transaction message does not contain exactly the participant and sponsor signers");
  }
  const expected = compileTransaction(message);
  const frozenMessage = new Uint8Array(expected.messageBytes);
  signal.throwIfAborted();
  const signed = await signTransactionMessageWithSigners(message, { abortSignal: signal });
  if (participant.address !== participantAddress || sponsor.address !== sponsorAddress) {
    throw new Error("Sponsored transaction signer identity changed during signing");
  }
  await verifyExactSignatures(signed, frozenMessage, participantAddress, sponsorAddress);
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during sponsored signing");
  }
  const signature = getSignatureFromTransaction(signed);
  return Object.freeze({
    version: 1,
    cluster: runtime.cluster,
    genesisHash: runtime.genesisHash,
    programAddress: runtime.programAddress,
    participantAddress,
    sponsorAddress,
    signature,
    signedWireBase64: getBase64EncodedWireTransaction(signed),
    messageSha256: sha256Base64Url(frozenMessage),
    recentBlockhash: latest.value.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight,
  });
}
