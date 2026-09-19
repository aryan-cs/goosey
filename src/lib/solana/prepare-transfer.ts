import {
  address, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  getBase64Encoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type TransactionSigner,
} from "@solana/kit";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { readGooseyConfiguration } from "./configuration";
import { buildFeatherTransfer, parseFeatherAmount } from "./feather-transfer";
import type { SolanaRuntime } from "./runtime";

/** Prepare a user-funded wallet transfer using verified chain state. This never
 * signs, submits, requests an airdrop, credits SQL, or asks a server to hold keys.
 * The balance check is advisory: execution still atomically checks real balances.
 * The wallet must approve this exact message; an uncertain send must not cause a
 * fresh signature automatically (SPL transfers have no application nonce).
 */
export async function prepareFeatherTransfer(input: {
  runtime: SolanaRuntime;
  sender: TransactionSigner;
  recipient: Address;
  displayAmount: string;
  signal?: AbortSignal;
}) {
  const amount = parseFeatherAmount(input.displayAmount);
  const recipient = address(input.recipient);
  if (recipient === input.sender.address || recipient === "11111111111111111111111111111111") {
    throw new Error("Choose another nonzero recipient wallet");
  }
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  signal.throwIfAborted();
  const configuration = await readGooseyConfiguration(input.runtime, signal);
  const plan = await buildFeatherTransfer({ mint: configuration.featherMint, sender: input.sender, recipient, amount });
  const rpc = createSolanaRpc(input.runtime.rpcUrl);
  const source = await rpc.getAccountInfo(plan.source, {
    encoding: "base64", commitment: "finalized", minContextSlot: configuration.finalizedSlot,
  }).send({ abortSignal: signal });
  if (!source.value || source.value.executable || source.value.owner !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("Sender feather account is missing or has an unexpected owner");
  }
  const bytes = getBase64Encoder().encode(source.value.data[0]);
  if (bytes.length !== 165) throw new Error("Unsupported sender token account");
  const token = getTokenDecoder().decode(bytes);
  if (token.mint !== configuration.featherMint || token.owner !== input.sender.address || token.state !== 1) {
    throw new Error("Sender feather account is not an initialized, unfrozen account for this wallet and mint");
  }
  if (token.amount < amount) throw new Error("Insufficient finalized feather balance");
  // Recheck network immediately before obtaining a signing lifetime. This guards
  // endpoint reconfiguration; it does not make an untrusted RPC cryptographically trusted.
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== input.runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during transfer preparation");
  }
  const latest = await rpc.getLatestBlockhash({
    commitment: "finalized", minContextSlot: source.context.slot,
  }).send({ abortSignal: signal });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(input.sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latest.value, tx),
    tx => appendTransactionMessageInstructions(plan.instructions, tx),
  );
  return {
    message, mint: configuration.featherMint, sender: input.sender.address, recipient,
    amount, source: plan.source, destination: plan.destination, finalizedBalance: token.amount,
    observedSlot: source.context.slot, lifetime: latest.value,
    cluster: input.runtime.cluster, genesisHash: input.runtime.genesisHash,
  };
}
