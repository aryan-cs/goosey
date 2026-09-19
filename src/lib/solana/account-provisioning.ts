import {
  address,
  createNoopSigner,
  createSolanaRpc,
  getAddressDecoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type Address,
  type Base64EncodedWireTransaction,
  type TransactionSigner,
} from "@solana/kit";
import { AccountState, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import {
  ensureAppManagedSolanaIdentity,
  loadAppManagedSolanaSigner,
  type AppManagedSolanaIdentity,
} from "./custody-service";
import { prepareEnrollment } from "./prepare-enrollment";
import { prepareFeatherClaim } from "./prepare-feather-claim";
import { buildClaimFeathersInstructions, deriveGooseyEnrollmentAddresses } from "./program-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import { trackTransactionStatus, type TransactionStatusResult } from "./transaction-status";

const MAX_U64 = (1n << 64n) - 1n;
const MAX_I64 = (1n << 63n) - 1n;

export type ProvisioningOperation = "enrollment" | "claim";

export type ProvisioningReceipt = Readonly<{
  operation: ProvisioningOperation;
  signature: string;
  signedWireBase64: string;
  lastValidBlockHeight: bigint;
}>;

export type ProvisioningCheckpoint = Readonly<{
  version: 1;
  userId: string;
  chainId: "solana:localnet" | "solana:devnet";
  genesisHash: string;
  programAddress: string;
  walletAddress: string;
  identityDigestHex: string;
  allowance: string;
  expiresAt: string;
  enrollmentAuthority: string;
  sponsor: string;
  pending: ProvisioningReceipt | null;
}>;

export interface ProvisioningJournal {
  load(scope: Readonly<{ userId: string; chainId: ProvisioningCheckpoint["chainId"]; genesisHash: string }>):
    Promise<ProvisioningCheckpoint | null>;
  /** Must durably commit with compare-and-set semantics before returning. */
  save(expected: ProvisioningCheckpoint | null, next: ProvisioningCheckpoint): Promise<void>;
}

export type FinalizedProvisioningState = Readonly<{
  slot: bigint;
  walletAddress: string;
  enrollment: "absent" | "authorized";
  claim: "unclaimed" | "claimed";
  associatedTokenAccount: "absent" | "initialized";
}>;

export type ProvisioningResult = Readonly<{
  status: "pending" | "ready" | "manual-reconciliation-required";
  operation: ProvisioningOperation | null;
  walletAddress: string;
  chainId: ProvisioningCheckpoint["chainId"];
  genesisHash: string;
  signature?: string;
  finalizedSlot?: bigint;
}>;

type PreparedOperation = Readonly<{
  message: Parameters<typeof signTransactionMessageWithSigners>[0];
  lastValidBlockHeight: bigint;
}>;

export type AccountProvisioningDependencies = Readonly<{
  ensureIdentity: typeof ensureAppManagedSolanaIdentity;
  loadSigner: typeof loadAppManagedSolanaSigner;
  readFinalizedState(runtime: SolanaRuntime, wallet: Address, identityDigest: Uint8Array, signal: AbortSignal):
    Promise<FinalizedProvisioningState>;
  prepareEnrollment(input: {
    runtime: SolanaRuntime;
    enrollmentAuthority: TransactionSigner;
    sponsor: TransactionSigner;
    wallet: Address;
    identityDigest: Uint8Array;
    allowance: bigint;
    expiresAt: bigint;
    signal: AbortSignal;
  }): Promise<PreparedOperation>;
  prepareClaim(input: {
    runtime: SolanaRuntime;
    wallet: TransactionSigner;
    sponsor: TransactionSigner;
    signal: AbortSignal;
  }): Promise<PreparedOperation>;
  track(runtime: SolanaRuntime, receipt: ProvisioningReceipt, signal: AbortSignal): Promise<TransactionStatusResult>;
  signAndEncode(prepared: PreparedOperation): Promise<Omit<ProvisioningReceipt, "operation">>;
  send(runtime: SolanaRuntime, receipt: ProvisioningReceipt, signal: AbortSignal): Promise<"submitted" | "unknown">;
}>;

function checkedDigest(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32 || !value.some(Boolean)) {
    throw new Error("Provisioning identity digest must be exactly 32 nonzero-domain bytes.");
  }
  return new Uint8Array(value);
}

function checkedGrant(allowance: bigint, expiresAt: bigint): void {
  if (typeof allowance !== "bigint" || allowance <= 0n || allowance > MAX_U64) {
    throw new Error("Provisioning allowance must be a positive u64 bigint.");
  }
  if (typeof expiresAt !== "bigint" || expiresAt <= 0n || expiresAt > MAX_I64) {
    throw new Error("Provisioning expiry must be a positive i64 bigint.");
  }
}

function validateCheckpoint(checkpoint: ProvisioningCheckpoint, identity: AppManagedSolanaIdentity, intent: {
  programAddress: string; identityDigestHex: string; allowance: string; expiresAt: string;
  enrollmentAuthority: string; sponsor: string;
}): void {
  if (checkpoint.version !== 1 || checkpoint.userId !== identity.userId || checkpoint.chainId !== identity.chainId
    || checkpoint.genesisHash !== identity.genesisHash || checkpoint.walletAddress !== identity.walletAddress
    || checkpoint.programAddress !== intent.programAddress || checkpoint.identityDigestHex !== intent.identityDigestHex
    || checkpoint.allowance !== intent.allowance || checkpoint.expiresAt !== intent.expiresAt
    || checkpoint.enrollmentAuthority !== intent.enrollmentAuthority || checkpoint.sponsor !== intent.sponsor) {
    throw new Error("Provisioning checkpoint does not match the authenticated custody identity and frozen provisioning intent.");
  }
  if (checkpoint.pending && (checkpoint.pending.signedWireBase64.length === 0
    || Buffer.byteLength(checkpoint.pending.signedWireBase64, "utf8") > 16_384)) {
    throw new Error("Provisioning checkpoint contains an invalid signed transaction envelope.");
  }
}

function validateFinalizedState(state: FinalizedProvisioningState, wallet: Address): void {
  if (typeof state.slot !== "bigint" || state.slot < 0n || state.walletAddress !== wallet
    || !["absent", "authorized"].includes(state.enrollment)
    || !["unclaimed", "claimed"].includes(state.claim)
    || !["absent", "initialized"].includes(state.associatedTokenAccount)) {
    throw new Error("Malformed finalized provisioning state.");
  }
  if (state.enrollment === "absent" && (state.claim !== "unclaimed" || state.associatedTokenAccount !== "absent")) {
    throw new Error("Finalized provisioning state is internally inconsistent.");
  }
  if (state.claim === "claimed" && state.associatedTokenAccount !== "initialized") {
    throw new Error("A finalized feather claim requires an initialized associated token account.");
  }
}

type ChainAccount = Readonly<{ owner: Address; executable: boolean; data: readonly [string, "base64"] }>;
const addressDecoder = getAddressDecoder();
const base64Encoder = getBase64Encoder();

function accountBytes(account: ChainAccount | null, owner: Address, size: number, name: string): Uint8Array {
  if (!account || account.owner !== owner || account.executable !== false || !Array.isArray(account.data)
    || account.data[1] !== "base64" || typeof account.data[0] !== "string") throw new Error(`Missing or invalid ${name} account.`);
  const bytes = new Uint8Array(base64Encoder.encode(account.data[0]));
  if (bytes.length !== size) throw new Error(`Invalid ${name} account size.`);
  return bytes;
}

async function verifyDiscriminator(bytes: Uint8Array, name: string): Promise<void> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${name}`)));
  if (!bytes.subarray(0, 8).every((byte, index) => byte === digest[index])) throw new Error(`Wrong ${name} discriminator.`);
}

function decodedAddress(bytes: Uint8Array, offset: number): Address {
  return addressDecoder.decode(bytes.subarray(offset, offset + 32));
}

async function readDefaultFinalizedState(runtime: SolanaRuntime, wallet: Address, identityDigest: Uint8Array,
  signal: AbortSignal): Promise<FinalizedProvisioningState> {
  const canonical = await deriveGooseyEnrollmentAddresses({ programAddress: runtime.programAddress, wallet, identityDigest });
  const tokenPlan = await buildClaimFeathersInstructions({ programAddress: runtime.programAddress, wallet: createNoopSigner(wallet) });
  const rpc = createSolanaRpc(runtime.rpcUrl);
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("RPC genesis mismatch during finalized provisioning verification.");
  }
  const response = await rpc.getMultipleAccounts([canonical.enrollment, canonical.identity, tokenPlan.walletTokens], {
    encoding: "base64", commitment: "finalized",
  }).send({ abortSignal: signal });
  if (typeof response.context.slot !== "bigint" || response.context.slot < 0n || response.value.length !== 3) {
    throw new Error("Malformed finalized provisioning snapshot.");
  }
  const [enrollmentAccount, identityAccount, tokenAccount] = response.value;
  if (enrollmentAccount === null && identityAccount === null && tokenAccount === null) {
    return { slot: response.context.slot, walletAddress: wallet, enrollment: "absent", claim: "unclaimed",
      associatedTokenAccount: "absent" };
  }
  const enrollment = accountBytes(enrollmentAccount, runtime.programAddress, 129, "Enrollment");
  const identity = accountBytes(identityAccount, runtime.programAddress, 104, "EnrollmentIdentity");
  await Promise.all([verifyDiscriminator(enrollment, "Enrollment"), verifyDiscriminator(identity, "EnrollmentIdentity")]);
  for (const bytes of [enrollment, identity]) {
    if (decodedAddress(bytes, 8) !== canonical.config || decodedAddress(bytes, 40) !== wallet
      || !bytes.subarray(72, 104).every((byte, index) => byte === identityDigest[index])) {
      throw new Error("Finalized enrollment identity binding mismatch.");
    }
  }
  if (enrollment[128] !== canonical.enrollmentBump) throw new Error("Finalized enrollment bump mismatch.");
  const view = new DataView(enrollment.buffer, enrollment.byteOffset, enrollment.byteLength);
  const allowance = view.getBigUint64(104, true), claimed = view.getBigUint64(112, true);
  if (allowance === 0n || claimed > allowance) throw new Error("Invalid finalized enrollment counters.");
  if (claimed === 0n && tokenAccount === null) {
    return { slot: response.context.slot, walletAddress: wallet, enrollment: "authorized", claim: "unclaimed",
      associatedTokenAccount: "absent" };
  }
  const tokenBytes = accountBytes(tokenAccount, TOKEN_PROGRAM_ADDRESS, 165, "feather associated token");
  const token = getTokenDecoder().decode(tokenBytes);
  if (token.mint !== canonical.featherMint || token.owner !== wallet || token.state !== AccountState.Initialized) {
    throw new Error("Finalized feather associated token account binding mismatch.");
  }
  return { slot: response.context.slot, walletAddress: wallet, enrollment: "authorized",
    claim: claimed === allowance ? "claimed" : "unclaimed",
    associatedTokenAccount: "initialized" };
}

function publicResult(checkpoint: ProvisioningCheckpoint, status: ProvisioningResult["status"],
  operation: ProvisioningOperation | null, extra: Pick<ProvisioningResult, "signature" | "finalizedSlot"> = {}): ProvisioningResult {
  return { status, operation, walletAddress: checkpoint.walletAddress, chainId: checkpoint.chainId,
    genesisHash: checkpoint.genesisHash, ...extra };
}

/**
 * Resumable server-only provisioning for an ordinary authenticated Goosey account.
 *
 * The caller owns a durable journal because no readiness schema exists yet. A
 * signed receipt is committed before its exact bytes are submitted. Ambiguous or
 * expired receipts are never replaced automatically. This function returns no
 * transaction message, instruction, secret key, or signed wire bytes.
 */
export async function provisionManagedSolanaAccount(input: Readonly<{
  userId: string;
  identityDigest: Uint8Array;
  allowance: bigint;
  expiresAt: bigint;
  enrollmentAuthority: TransactionSigner;
  sponsor: TransactionSigner;
  journal: ProvisioningJournal;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  dependencies?: AccountProvisioningDependencies;
}>): Promise<ProvisioningResult> {
  if (!input.userId || input.userId.length > 191) throw new Error("An authenticated Goosey user id is required.");
  const digest = checkedDigest(input.identityDigest);
  checkedGrant(input.allowance, input.expiresAt);
  const signal = input.signal ?? AbortSignal.timeout(60_000);
  signal.throwIfAborted();
  const env = input.env ?? process.env;
  const runtime = resolveSolanaRuntime(env);
  const dependencies = input.dependencies ?? defaultAccountProvisioningDependencies;
  const identity = await dependencies.ensureIdentity(input.userId, env);
  const wallet = address(identity.walletAddress);
  if (identity.chainId !== `solana:${runtime.cluster}` || identity.genesisHash !== runtime.genesisHash) {
    throw new Error("Custody identity network does not match the pinned Solana runtime.");
  }
  const signer = await dependencies.loadSigner(input.userId, env);
  if (signer.address !== wallet) throw new Error("Custody signer does not match its public identity.");
  if (input.enrollmentAuthority.address === wallet || input.sponsor.address === wallet) {
    throw new Error("Custody, enrollment authority, and sponsor roles must remain separate.");
  }
  if (input.enrollmentAuthority.address === input.sponsor.address) {
    throw new Error("Enrollment authority and sponsor roles must remain separate.");
  }
  const scope = { userId: identity.userId, chainId: identity.chainId, genesisHash: identity.genesisHash };
  const intent = {
    programAddress: runtime.programAddress.toString(),
    identityDigestHex: Buffer.from(digest).toString("hex"),
    allowance: input.allowance.toString(),
    expiresAt: input.expiresAt.toString(),
    enrollmentAuthority: input.enrollmentAuthority.address.toString(),
    sponsor: input.sponsor.address.toString(),
  };
  let checkpoint = await input.journal.load(scope);
  if (checkpoint) validateCheckpoint(checkpoint, identity, intent);
  else {
    const initial: ProvisioningCheckpoint = { version: 1, ...scope, ...intent,
      walletAddress: identity.walletAddress, pending: null };
    await input.journal.save(null, initial);
    checkpoint = initial;
  }

  let state = await dependencies.readFinalizedState(runtime, wallet, digest, signal);
  validateFinalizedState(state, wallet);
  if (state.claim === "claimed") {
    if (checkpoint.pending) {
      const cleared = { ...checkpoint, pending: null };
      await input.journal.save(checkpoint, cleared);
      checkpoint = cleared;
    }
    return publicResult(checkpoint, "ready", null, { finalizedSlot: state.slot });
  }

  if (checkpoint.pending) {
    const tracked = await dependencies.track(runtime, checkpoint.pending, signal);
    if (tracked.status === "unknown" || tracked.status === "submitted" || tracked.status === "confirmed") {
      return publicResult(checkpoint, "pending", checkpoint.pending.operation, { signature: checkpoint.pending.signature });
    }
    if (tracked.status === "expired") {
      return publicResult(checkpoint, "manual-reconciliation-required", checkpoint.pending.operation,
        { signature: checkpoint.pending.signature });
    }
    if (tracked.status === "failed") {
      return publicResult(checkpoint, "manual-reconciliation-required", checkpoint.pending.operation,
        { signature: checkpoint.pending.signature });
    }
    state = await dependencies.readFinalizedState(runtime, wallet, digest, signal);
    validateFinalizedState(state, wallet);
    const transitionVerified = checkpoint.pending.operation === "enrollment"
      ? state.enrollment === "authorized"
      : state.claim === "claimed";
    if (!transitionVerified) throw new Error("Finalized transaction did not produce the required provisioning state.");
    const cleared = { ...checkpoint, pending: null };
    await input.journal.save(checkpoint, cleared);
    checkpoint = cleared;
    if (state.claim === "claimed") return publicResult(checkpoint, "ready", null, { finalizedSlot: state.slot });
  }

  const operation: ProvisioningOperation = state.enrollment === "absent" ? "enrollment" : "claim";
  const prepared = operation === "enrollment"
    ? await dependencies.prepareEnrollment({ runtime, enrollmentAuthority: input.enrollmentAuthority, sponsor: input.sponsor,
      wallet, identityDigest: digest, allowance: input.allowance, expiresAt: input.expiresAt, signal })
    : await dependencies.prepareClaim({ runtime, wallet: signer, sponsor: input.sponsor, signal });
  const encoded = await dependencies.signAndEncode(prepared);
  const receipt: ProvisioningReceipt = Object.freeze({ operation, ...encoded });
  const pending = { ...checkpoint, pending: receipt };
  await input.journal.save(checkpoint, pending);
  checkpoint = pending;
  const submission = await dependencies.send(runtime, receipt, signal);
  return publicResult(checkpoint, "pending", operation, { signature: receipt.signature,
    ...(submission === "unknown" ? {} : {}) });
}

export const defaultAccountProvisioningDependencies: AccountProvisioningDependencies = {
  ensureIdentity: ensureAppManagedSolanaIdentity,
  loadSigner: loadAppManagedSolanaSigner,
  readFinalizedState: readDefaultFinalizedState,
  async prepareEnrollment(input) {
    const prepared = await prepareEnrollment(input);
    return { message: setTransactionMessageFeePayerSigner(input.sponsor, prepared.message),
      lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight };
  },
  async prepareClaim(input) {
    const prepared = await prepareFeatherClaim(input);
    const plan = await buildClaimFeathersInstructions({ programAddress: input.runtime.programAddress, wallet: input.wallet,
      createAta: prepared.createsAta, payer: input.sponsor });
    if (plan.walletTokens !== prepared.walletTokens || plan.enrollment !== prepared.enrollment) {
      throw new Error("Sponsored claim builder changed the verified account bindings.");
    }
    const message = { ...prepared.message, instructions: plan.instructions };
    return { message: setTransactionMessageFeePayerSigner(input.sponsor, message),
      lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight } as PreparedOperation;
  },
  async track(runtime, receipt, signal) {
    return trackTransactionStatus(createSolanaRpc(runtime.rpcUrl), { signature: receipt.signature,
      lastValidBlockHeight: receipt.lastValidBlockHeight, commitment: "finalized", signal });
  },
  async signAndEncode(prepared) {
    const signed = await signTransactionMessageWithSigners(prepared.message);
    return { signature: getSignatureFromTransaction(signed), signedWireBase64: getBase64EncodedWireTransaction(signed),
      lastValidBlockHeight: prepared.lastValidBlockHeight };
  },
  async send(runtime, receipt, signal) {
    const rpc = createSolanaRpc(runtime.rpcUrl);
    if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
      throw new Error("RPC genesis mismatch before managed provisioning submission.");
    }
    try {
      const returned = await rpc.sendTransaction(receipt.signedWireBase64 as Base64EncodedWireTransaction,
        { encoding: "base64", skipPreflight: false,
        preflightCommitment: "confirmed", maxRetries: 0n }).send({ abortSignal: signal });
      return returned === receipt.signature ? "submitted" : "unknown";
    } catch {
      return "unknown";
    }
  },
};
