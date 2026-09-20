import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createSolanaRpc,
  createTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type TransactionPartialSigner,
} from "@solana/kit";

import { readGooseyConfiguration } from "@/lib/solana/configuration";
import { buildBookSetupInstruction, deriveGooseyBookAddress, GOOSEY_BOOK_BYTES,
  GOOSEY_BOOK_GROWTH } from "@/lib/solana/exchange-client";
import type { ManagedMarketBookStep } from "@/lib/solana/managed-market-book-service";
import { resolveSolanaRuntime, type SolanaRuntime } from "@/lib/solana/runtime";
import type { PreparedWalletTransaction } from "@/lib/solana/wallet-transaction";

const DRAFT_TAG = "GOOSEYI1";
const READY_TAG = "GOOSEYB1";

export type ManagedMarketBookState = Readonly<{
  book: Address;
  ready: boolean;
  size: number;
  finalizedSlot: bigint;
}>;

export async function readManagedMarketBookState(input: Readonly<{
  runtime: SolanaRuntime;
  marketAddress: Address;
  minimumFinalizedSlot?: bigint;
  signal?: AbortSignal;
}>): Promise<ManagedMarketBookState> {
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: input.runtime.cluster,
    GOOSEY_SOLANA_RPC_URL: input.runtime.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: input.runtime.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: input.runtime.genesisHash });
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  const { book } = await deriveGooseyBookAddress(runtime.programAddress, address(input.marketAddress));
  const rpc = createSolanaRpc(runtime.rpcUrl);
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Order-book RPC genesis mismatch");
  }
  const minimumFinalizedSlot = input.minimumFinalizedSlot ?? 0n;
  if (typeof minimumFinalizedSlot !== "bigint" || minimumFinalizedSlot < 0n) throw new Error("Invalid minimum finalized slot");
  const response = await rpc.getAccountInfo(book, { encoding: "base64", commitment: "finalized",
    minContextSlot: minimumFinalizedSlot }).send({ abortSignal: signal });
  if (typeof response.context.slot !== "bigint" || response.context.slot < minimumFinalizedSlot) {
    throw new Error("Invalid finalized order-book context");
  }
  if (response.value === null) return Object.freeze({ book, ready: false, size: 0, finalizedSlot: response.context.slot });
  const account = response.value;
  if (account.owner !== runtime.programAddress || account.executable !== false || !Array.isArray(account.data)
    || account.data[1] !== "base64" || typeof account.data[0] !== "string") {
    throw new Error("Invalid order-book account envelope");
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  if (getBase64Decoder().decode(bytes) !== account.data[0]) throw new Error("Noncanonical order-book account encoding");
  const tag = new TextDecoder().decode(bytes.subarray(0, 8));
  if (tag === DRAFT_TAG) {
    if (bytes.length < GOOSEY_BOOK_GROWTH || bytes.length > GOOSEY_BOOK_BYTES
      || (bytes.length !== GOOSEY_BOOK_BYTES && bytes.length % GOOSEY_BOOK_GROWTH !== 0)
      || bytes.subarray(8).some(Boolean)) throw new Error("Invalid unfinished order-book draft");
    return Object.freeze({ book, ready: false, size: bytes.length, finalizedSlot: response.context.slot });
  }
  if (tag !== READY_TAG || bytes.length !== GOOSEY_BOOK_BYTES) throw new Error("Invalid order-book lifecycle tag or size");
  return Object.freeze({ book, ready: true, size: bytes.length, finalizedSlot: response.context.slot });
}

function assertPrecondition(step: ManagedMarketBookStep, state: ManagedMarketBookState): void {
  if (step.kind === "create" && state.size === 0) return;
  if (step.kind === "grow" && !state.ready && state.size === step.expectedSize) return;
  if (step.kind === "finalize" && !state.ready && state.size === GOOSEY_BOOK_BYTES) return;
  throw new Error("Finalized order-book state does not match the frozen provisioning step");
}

export async function prepareManagedMarketBookTransaction(input: Readonly<{
  runtime: SolanaRuntime;
  authority: TransactionPartialSigner;
  marketId: bigint;
  marketAddress: Address;
  step: ManagedMarketBookStep;
  signal?: AbortSignal;
}>) {
  const signal = input.signal ?? AbortSignal.timeout(20_000);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: input.runtime.cluster,
    GOOSEY_SOLANA_RPC_URL: input.runtime.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: input.runtime.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: input.runtime.genesisHash });
  const configuration = await readGooseyConfiguration(runtime, signal);
  if (configuration.admin !== input.authority.address) {
    throw new Error("Configured market authority is not the finalized Goosey program admin");
  }
  const observed = await readManagedMarketBookState({ runtime, marketAddress: input.marketAddress,
    minimumFinalizedSlot: configuration.finalizedSlot, signal });
  assertPrecondition(input.step, observed);
  const built = await buildBookSetupInstruction({ programAddress: runtime.programAddress,
    marketId: input.marketId, admin: input.authority, step: input.step });
  if (built.market !== input.marketAddress || built.book !== observed.book) throw new Error("Order-book derivation changed");
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: observed.finalizedSlot })
    .send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < observed.finalizedSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) {
    throw new Error("Invalid finalized order-book transaction lifetime");
  }
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  const message = pipe(createTransactionMessage({ version: 0 }),
    value => setTransactionMessageFeePayerSigner(input.authority, value),
    value => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    value => appendTransactionMessageInstructions([built.instruction], value));
  const prepared = { message, sender: input.authority.address, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  const signed = await signTransactionMessageWithSigners(message, { abortSignal: signal });
  return Object.freeze({ prepared, signed, market: built.market, book: built.book, observed,
    receipt: Object.freeze({ signature: getSignatureFromTransaction(signed),
      signedWireBase64: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: lifetime.lastValidBlockHeight,
      recentBlockhash: latest.value.blockhash, authorityAddress: input.authority.address }) });
}
