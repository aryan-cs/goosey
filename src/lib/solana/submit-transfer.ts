import {
  address, assertIsFullySignedTransaction, compileTransaction, createSolanaRpc,
  getBase64EncodedWireTransaction, getPublicKeyFromAddress, getSignatureFromTransaction,
  verifySignature, type Transaction,
} from "@solana/kit";
import type { prepareFeatherTransfer } from "./prepare-transfer";
import type { SolanaRuntime } from "./runtime";

type PreparedTransfer = Awaited<ReturnType<typeof prepareFeatherTransfer>>;
export type TransferSubmission = {
  status: "submitted" | "unknown";
  signature: string;
  lastValidBlockHeight: bigint;
  /** The only safe automatic rebroadcast is these identical already-signed bytes.
   * Persist locally before submission; never request a new wallet signature on timeout. */
  signedWireBase64: string;
};

/** User-wallet-only send, not confirmation or settlement. No server signer,
 * mainnet support, automatic replacement transaction, or database balance write.
 * Persist the onPrepared receipt before the single send to recover an ambiguous
 * network interruption. Throwing from that callback prevents sending.
 */
export async function submitSignedFeatherTransfer(input: {
  runtime: SolanaRuntime;
  prepared: PreparedTransfer;
  signed: Transaction;
  onPrepared: (receipt: Omit<TransferSubmission, "status">) => void | Promise<void>;
  signal?: AbortSignal;
}) : Promise<TransferSubmission> {
  const runtime = { ...input.runtime };
  const { prepared } = input;
  const lastValidBlockHeight = prepared.message.lifetimeConstraint.lastValidBlockHeight;
  if (!["localnet", "devnet"].includes(runtime.cluster) || prepared.cluster !== runtime.cluster
    || prepared.genesisHash !== runtime.genesisHash) throw new Error("Transfer network does not match the prepared request");
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const expected = compileTransaction(prepared.message);
  // Copy wallet-controlled buffers before asynchronous verification/persistence.
  const signed: Transaction = {
    messageBytes: new Uint8Array(input.signed.messageBytes) as unknown as Transaction["messageBytes"],
    signatures: Object.fromEntries(Object.entries(input.signed.signatures).map(([key, value]) =>
      [key, value === null ? null : new Uint8Array(value)])) as Transaction["signatures"],
  };
  if (signed.messageBytes.length !== expected.messageBytes.length
    || !signed.messageBytes.every((value, index) => value === expected.messageBytes[index])) {
    throw new Error("Wallet altered the prepared transfer message");
  }
  const expectedSigners = Object.keys(expected.signatures).sort();
  if (expectedSigners.length !== 1 || expectedSigners[0] !== prepared.sender
    || Object.keys(signed.signatures).sort().join(",") !== expectedSigners.join(",")) {
    throw new Error("Unexpected transfer signer set");
  }
  assertIsFullySignedTransaction(signed);
  for (const signer of expectedSigners) {
    const signature = signed.signatures[address(signer)];
    if (!signature || !await verifySignature(await getPublicKeyFromAddress(address(signer)), signature, signed.messageBytes)) {
      throw new Error("Wallet transfer signature is invalid");
    }
  }
  const rpc = createSolanaRpc(runtime.rpcUrl);
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("RPC genesis mismatch before submission");
  const height = await rpc.getBlockHeight({ commitment: "confirmed" }).send({ abortSignal: signal });
  if (height > lastValidBlockHeight) throw new Error("Prepared transfer signing lifetime has expired; reconcile before requesting another signature");
  const receipt = Object.freeze({
    signature: getSignatureFromTransaction(signed),
    lastValidBlockHeight,
    signedWireBase64: getBase64EncodedWireTransaction(signed),
  });
  await input.onPrepared(receipt);
  signal.throwIfAborted();
  try {
    const returned = await rpc.sendTransaction(receipt.signedWireBase64, {
      encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0n,
    }).send({ abortSignal: signal });
    return { ...receipt, status: returned === receipt.signature ? "submitted" : "unknown" };
  } catch {
    // Includes abort after handing bytes to the transport. Delivery cannot be
    // inferred from a disconnected client; inspect this same signature next.
    return { ...receipt, status: "unknown" };
  }
}
