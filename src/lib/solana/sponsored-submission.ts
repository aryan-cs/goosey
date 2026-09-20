import { createHash } from "node:crypto";

import {
  address,
  assertIsFullySignedTransaction,
  blockhash,
  createSolanaRpc,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  verifySignature,
  type Base64EncodedWireTransaction,
  type Transaction,
} from "@solana/kit";

import { probeSolanaRuntime, resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { SignedSponsoredTransaction } from "./sponsored-transaction";

export type SponsoredSubmission = Readonly<{
  status: "submitted" | "unknown";
  signature: string;
  lastValidBlockHeight: bigint;
  signedWireBase64: Base64EncodedWireTransaction;
}>;

type SubmissionRpc = Pick<ReturnType<typeof createSolanaRpc>,
  "getGenesisHash" | "getAccountInfo" | "getBlockHeight" | "isBlockhashValid" | "sendTransaction">;

const MAX_U64 = (1n << 64n) - 1n;

async function decodeAndVerify(record: SignedSponsoredTransaction): Promise<void> {
  if (record.version !== 1 || typeof record.signedWireBase64 !== "string" || record.signedWireBase64.length > 2_000) {
    throw new Error("Invalid sponsored transaction receipt");
  }
  let transaction: Transaction;
  try {
    transaction = getTransactionDecoder().decode(getBase64Encoder().encode(record.signedWireBase64));
  } catch {
    throw new Error("Invalid sponsored transaction wire encoding");
  }
  if (getBase64EncodedWireTransaction(transaction) !== record.signedWireBase64
    || getSignatureFromTransaction(transaction) !== record.signature) {
    throw new Error("Sponsored transaction receipt is not canonical");
  }
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0 || message.lifetimeToken !== record.recentBlockhash
    || message.staticAccounts[0] !== record.sponsorAddress
    || (message.addressTableLookups?.length ?? 0) !== 0) {
    throw new Error("Sponsored transaction receipt message binding changed");
  }
  const expectedPrograms = (record.instructionProgramAddresses ?? [record.programAddress])
    .map(value => address(value)).sort();
  if (expectedPrograms.length < 1 || expectedPrograms.length > 32
    || new Set(expectedPrograms).size !== expectedPrograms.length) {
    throw new Error("Sponsored transaction receipt has an invalid program set");
  }
  const invokedPrograms = [...new Set(message.instructions.map(instruction => {
    const programAddress = message.staticAccounts[instruction.programAddressIndex];
    if (!programAddress) throw new Error("Sponsored transaction has an invalid program index");
    return address(programAddress);
  }))].sort();
  if (JSON.stringify(invokedPrograms) !== JSON.stringify(expectedPrograms)) {
    throw new Error("Sponsored transaction invoked program set changed");
  }
  const expectedSigners = [address(record.participantAddress), address(record.sponsorAddress)].sort();
  if (expectedSigners[0] === expectedSigners[1]
    || Object.keys(transaction.signatures).sort().join(",") !== expectedSigners.join(",")) {
    throw new Error("Sponsored transaction receipt has an unexpected signer set");
  }
  assertIsFullySignedTransaction(transaction);
  for (const signerAddress of expectedSigners) {
    const signer = address(signerAddress);
    const signature = transaction.signatures[signer];
    if (!signature || !await verifySignature(await getPublicKeyFromAddress(signer), signature, transaction.messageBytes)) {
      throw new Error("Sponsored transaction receipt has an invalid signature");
    }
  }
  const digest = createHash("sha256").update(new Uint8Array(transaction.messageBytes)).digest("base64url");
  if (digest !== record.messageSha256) {
    throw new Error("Sponsored transaction receipt message digest changed");
  }
}

/**
 * Revalidates a signed sponsored receipt, calls the caller's durability hook,
 * then performs one preflight-enabled send. It never persists or retries. A
 * transport failure is ambiguous and therefore returns `unknown`.
 */
export async function submitSponsoredTransaction(input: {
  runtime: SolanaRuntime;
  signed: SignedSponsoredTransaction;
  onPrepared: (receipt: Omit<SponsoredSubmission, "status">) => void | Promise<void>;
  signal?: AbortSignal;
  rpc?: SubmissionRpc;
}): Promise<SponsoredSubmission> {
  const runtime = resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: input.runtime.cluster,
    GOOSEY_SOLANA_RPC_URL: input.runtime.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: input.runtime.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: input.runtime.genesisHash,
  });
  // Capture every public receipt field before decode/signature verification
  // crosses an asynchronous boundary. No signer or secret material is present.
  const signed: SignedSponsoredTransaction = Object.freeze({ ...input.signed });
  if (signed.cluster !== runtime.cluster || signed.genesisHash !== runtime.genesisHash
    || address(signed.programAddress) !== runtime.programAddress
    || typeof signed.lastValidBlockHeight !== "bigint" || signed.lastValidBlockHeight < 0n
    || signed.lastValidBlockHeight > MAX_U64) {
    throw new Error("Sponsored transaction receipt does not match the pinned runtime");
  }
  await decodeAndVerify(signed);
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const rpc = input.rpc ?? createSolanaRpc(runtime.rpcUrl);
  signal.throwIfAborted();
  const probe = await probeSolanaRuntime(runtime, rpc, signal);
  const minimumSlot = BigInt(probe.finalizedSlot);
  if (minimumSlot < 0n || minimumSlot > MAX_U64) throw new Error("Invalid finalized deployment slot");
  const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: signal });
  if (typeof blockHeight !== "bigint" || blockHeight < 0n || blockHeight > MAX_U64) {
    throw new Error("Invalid block height before sponsored submission");
  }
  if (blockHeight > signed.lastValidBlockHeight) {
    throw new Error("Sponsored transaction lifetime expired; reconcile before creating a replacement");
  }
  const blockhashStatus = await rpc.isBlockhashValid(blockhash(signed.recentBlockhash), {
    commitment: "confirmed",
    minContextSlot: minimumSlot,
  })
    .send({ abortSignal: signal });
  if (blockhashStatus.context.slot < minimumSlot || !blockhashStatus.value) {
    throw new Error("Sponsored transaction blockhash expired; reconcile before creating a replacement");
  }
  const receipt = Object.freeze({
    signature: signed.signature,
    lastValidBlockHeight: signed.lastValidBlockHeight,
    signedWireBase64: signed.signedWireBase64,
  });
  await input.onPrepared(receipt);
  signal.throwIfAborted();
  await probeSolanaRuntime(runtime, rpc, signal);
  try {
    const returned = await rpc.sendTransaction(receipt.signedWireBase64, {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0n,
    }).send({ abortSignal: signal });
    return Object.freeze({ ...receipt, status: returned === receipt.signature ? "submitted" : "unknown" });
  } catch {
    return Object.freeze({ ...receipt, status: "unknown" });
  }
}
