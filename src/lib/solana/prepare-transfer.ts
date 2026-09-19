import {
  address, assertIsTransactionSigner, blockhash, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  getBase64Decoder, getBase64Encoder, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type TransactionSigner,
} from "@solana/kit";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { readGooseyConfiguration } from "./configuration";
import { buildFeatherTransfer, parseFeatherAmount } from "./feather-transfer";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";

const MAX_U64 = (1n << 64n) - 1n;
function context(slot: bigint, minimum: bigint) {
  if (typeof slot !== "bigint" || slot < minimum || slot > MAX_U64) throw new Error("Invalid finalized transfer context");
}

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
  // Capture intent before RPC: account/amount/network changes require a NEW
  // explicit preparation, never a mixed transaction assembled across awaits.
  const supplied = { ...input.runtime }, sender = input.sender;
  assertIsTransactionSigner(sender);
  const senderAddress = address(sender.address);
  const amount = parseFeatherAmount(input.displayAmount);
  const recipient = address(input.recipient);
  if (recipient === senderAddress || recipient === "11111111111111111111111111111111") {
    throw new Error("Choose another nonzero recipient wallet");
  }
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  signal.throwIfAborted();
  const configuration = await readGooseyConfiguration(runtime, signal);
  context(configuration.finalizedSlot, 0n);
  if (sender.address !== senderAddress) throw new Error("Sender changed during transfer preparation");
  const plan = await buildFeatherTransfer({ mint: configuration.featherMint, sender, recipient, amount });
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const source = await rpc.getAccountInfo(plan.source, {
    encoding: "base64", commitment: "finalized", minContextSlot: configuration.finalizedSlot,
  }).send({ abortSignal: signal });
  context(source.context.slot, configuration.finalizedSlot);
  if (!source.value || source.value.executable || source.value.owner !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error("Sender feather account is missing or has an unexpected owner");
  }
  if (!Array.isArray(source.value.data) || source.value.data.length !== 2 || source.value.data[1] !== "base64"
    || typeof source.value.data[0] !== "string" || source.value.data[0].length !== 220) throw new Error("Unsupported sender token encoding");
  const bytes = new Uint8Array(getBase64Encoder().encode(source.value.data[0]));
  if (bytes.length !== 165 || getBase64Decoder().decode(bytes) !== source.value.data[0]) throw new Error("Unsupported sender token account");
  const options = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (![0, 1].includes(options.getUint32(72, true)) || options.getUint32(109, true) !== 0
    || ![0, 1].includes(options.getUint32(129, true))) throw new Error("Unsupported sender token options");
  const token = getTokenDecoder().decode(bytes);
  if (token.mint !== configuration.featherMint || token.owner !== senderAddress || token.state !== 1) {
    throw new Error("Sender feather account is not an initialized, unfrozen account for this wallet and mint");
  }
  if (token.amount < amount) throw new Error("Insufficient finalized feather balance");
  // Recheck network immediately before obtaining a signing lifetime. This guards
  // endpoint reconfiguration; it does not make an untrusted RPC cryptographically trusted.
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during transfer preparation");
  }
  const latest = await rpc.getLatestBlockhash({
    commitment: "finalized", minContextSlot: source.context.slot,
  }).send({ abortSignal: signal });
  context(latest.context.slot, source.context.slot);
  if (typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n
    || latest.value.lastValidBlockHeight > MAX_U64) throw new Error("Invalid transfer signing lifetime");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (sender.address !== senderAddress) throw new Error("Sender changed during transfer preparation");
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    tx => appendTransactionMessageInstructions(plan.instructions, tx),
  );
  return {
    message, mint: configuration.featherMint, sender: senderAddress, recipient,
    amount, source: plan.source, destination: plan.destination, finalizedBalance: token.amount,
    observedSlot: source.context.slot, lifetime,
    cluster: runtime.cluster, genesisHash: runtime.genesisHash,
  };
}
