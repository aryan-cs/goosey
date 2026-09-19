import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner } from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import { buildCancelOrderInstruction } from "./exchange-client";
import type { SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

/** Prepare an explicit owner cancellation, not a cleanup or replacement.
 * Derive the target hint and nonce from a single finalized book/escrow read.
 * A concurrent fill/removal can invalidate the hint; never retarget or sign again
 * automatically. Cancellation does not require the market to remain open.
 */
export async function prepareCancelOrder(input: {
  runtime: SolanaRuntime; sender: TransactionSigner; marketId: bigint; orderId: bigint; signal?: AbortSignal;
}) {
  const runtime = { ...input.runtime }, sender = input.sender, marketId = input.marketId, orderId = input.orderId;
  assertIsTransactionSigner(sender);
  const senderAddress = address(sender.address), signal = input.signal ?? AbortSignal.timeout(15_000);
  if (typeof orderId !== "bigint" || orderId <= 0n || orderId >= 1n << 64n) throw new Error("Invalid cancellation order ID");
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: senderAddress }, { rpc, signal, includeOrderBook: true });
  if (!snapshot.registered || !snapshot.seat || !snapshot.orderBook?.reservesReconciled
    || snapshot.wallet !== senderAddress) throw new Error("Missing verified cancellation seat/book");
  const order = snapshot.orderBook.orders.find(order => order.id === orderId);
  if (!order) throw new Error("Order is no longer resting; refresh its history before taking another action");
  if (order.wallet !== senderAddress || order.ownerSeat !== snapshot.seat.index) throw new Error("Only the order owner can cancel");
  const target = { orderId, side: order.side, heapIndex: order.heapIndex };
  const expectedNonce = snapshot.seat.nextNonce;
  const plan = await buildCancelOrderInstruction({ programAddress: runtime.programAddress, marketId, wallet: sender,
    seats: snapshot.seats, target, expectedNonce });
  if (plan.market !== snapshot.market || plan.book !== snapshot.orderBook.book || plan.locator !== snapshot.locator
    || plan.config !== snapshot.config || sender.address !== senderAddress) throw new Error("Cancellation snapshot bindings changed");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during cancellation preparation");
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < snapshot.finalizedSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid cancellation signing lifetime");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (sender.address !== senderAddress) throw new Error("Wallet changed during cancellation preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
  const prepared = { message, sender: senderAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, market: plan.market, book: plan.book, orderId, target, expectedNonce,
    observedSlot: snapshot.finalizedSlot, bookRevision: snapshot.orderBook.revision, lifetime,
    // Advisory only: a racing partial fill can change the released reserve.
    observedReserve: { ...order.reserve } };
}
