import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionSigner,
  blockhash,
  createSolanaRpc,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";

import { buildCancelOrderInstruction, buildPlaceOrderInstruction } from "./exchange-client";
import { readGooseyEscrow } from "./escrow-read";
import { buyOrderReserve } from "./order-reserve";
import { ORDER_COMPUTE_UNIT_LIMIT } from "./prepare-order";
import type { SolanaRuntime } from "./runtime";

const U64_MAX = (1n << 64n) - 1n;

export type PrepareOrderReplacementInput = Readonly<{
  runtime: SolanaRuntime;
  sender: TransactionSigner;
  marketId: bigint;
  orderId: bigint;
  price: bigint;
  quantity: bigint;
  postOnly: boolean;
  selfTrade: "CANCEL_AGGRESSOR" | "CANCEL_RESTING" | "CANCEL_BOTH";
  /** Undefined preserves the resting order's expiry; null removes it. */
  expiresAt?: bigint | null;
  touches?: number;
  signal?: AbortSignal;
}>;

/** Builds one atomic cancel-then-place transaction from one coherent finalized
 * snapshot. Sequential nonces make instruction order part of the authorization;
 * Solana transaction atomicity preserves the original if placement fails. */
export async function prepareOrderReplacement(input: PrepareOrderReplacementInput) {
  const runtime = { ...input.runtime }, sender = input.sender;
  assertIsTransactionSigner(sender);
  const wallet = address(sender.address), signal = input.signal ?? AbortSignal.timeout(15_000);
  if (typeof input.orderId !== "bigint" || input.orderId <= 0n || input.orderId > U64_MAX
    || typeof input.price !== "bigint" || input.price <= 0n || input.price >= 1_000_000n
    || typeof input.quantity !== "bigint" || input.quantity <= 0n || input.quantity > 10_000_000n
    || typeof input.postOnly !== "boolean") throw new Error("Invalid replacement parameters");
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId: input.marketId, wallet }, {
    rpc, signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true,
  });
  if (!snapshot.registered || !snapshot.seat || snapshot.wallet !== wallet
    || !snapshot.orderBook?.reservesReconciled || !snapshot.resolution || !snapshot.marketTerms) {
    throw new Error("Missing verified replacement seat/book/market state");
  }
  if (snapshot.resolution.phase !== 0) throw new Error("Market resolution is missing or no longer open");
  const terms = snapshot.marketTerms, resolution = snapshot.resolution;
  if (terms.sealed !== true || terms.acceptanceBits !== 3
    || terms.market !== snapshot.market || terms.creator !== resolution.creator
    || terms.proposer.wallet !== resolution.proposer.wallet || terms.proposer.enrollment !== resolution.proposer.enrollment
    || terms.approver.wallet !== resolution.approver.wallet || terms.approver.enrollment !== resolution.approver.enrollment) {
    throw new Error("Market terms and frozen resolution reviewers mismatch");
  }
  if (wallet === terms.proposer.wallet || wallet === terms.approver.wallet) {
    throw new Error("Designated reviewer wallets cannot trade this market");
  }
  const { seat, marketState, orderBook } = snapshot;
  const original = orderBook.orders.find(order => order.id === input.orderId);
  if (!original) throw new Error("Order is no longer resting; refresh its history before replacing it");
  if (original.wallet !== wallet || original.ownerSeat !== seat.index) throw new Error("Only the order owner can replace it");
  if (input.price >= marketState.payoutMilli) throw new Error("Replacement price must be below the market payout");
  if (seat.nextNonce > U64_MAX - 2n || orderBook.nextSequence === U64_MAX) {
    throw new Error("Replacement nonce or order sequence is exhausted");
  }
  const replacementExpiry = input.expiresAt === undefined ? original.expiresAt : input.expiresAt;
  const cancel = await buildCancelOrderInstruction({ programAddress: runtime.programAddress,
    marketId: input.marketId, wallet: sender, seats: snapshot.seats,
    target: { orderId: original.id, side: original.side, heapIndex: original.heapIndex },
    expectedNonce: seat.nextNonce });
  const place = await buildPlaceOrderInstruction({ programAddress: runtime.programAddress,
    marketId: input.marketId, wallet: sender, seats: snapshot.seats,
    expectedNonce: seat.nextNonce + 1n, price: input.price, quantity: input.quantity,
    outcome: original.outcome, action: original.action, timeInForce: "GTC", selfTrade: input.selfTrade,
    postOnly: input.postOnly, ...(replacementExpiry === null ? {} : { expiresAt: replacementExpiry }),
    touches: input.touches ?? 8 });
  if (cancel.market !== snapshot.market || place.market !== snapshot.market
    || cancel.config !== snapshot.config || place.config !== snapshot.config
    || cancel.locator !== snapshot.locator || place.locator !== snapshot.locator
    || cancel.book !== orderBook.book || place.book !== orderBook.book
    || cancel.seats !== snapshot.seats || place.seats !== snapshot.seats
    || place.vault !== snapshot.vault || place.resolution !== resolution.address || place.terms !== terms.address) {
    throw new Error("Replacement snapshot bindings changed");
  }

  const availableCashAfterCancel = seat.availableCash + original.reserve.cash;
  const availableYesAfterCancel = seat.yes - seat.reservedYes + original.reserve.yes;
  const availableNoAfterCancel = seat.no - seat.reservedNo + original.reserve.no;
  const requiredCash = original.action === "BUY" ? buyOrderReserve({ limitPriceMilli: input.price,
    quantity: input.quantity, feeBps: marketState.feeBps }).requiredCash : 0n;
  const availablePosition = original.outcome === "YES" ? availableYesAfterCancel : availableNoAfterCancel;
  if (original.action === "BUY" && availableCashAfterCancel < requiredCash) {
    throw new Error("Insufficient finalized escrow cash after releasing the original reserve");
  }
  if (original.action === "SELL" && availablePosition < input.quantity) {
    throw new Error("Insufficient finalized positions after releasing the original reserve");
  }
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during replacement preparation");
  }
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: snapshot.finalizedSlot })
    .send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < snapshot.finalizedSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) {
    throw new Error("Invalid replacement signing lifetime");
  }
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  const budgetData = new Uint8Array(5); budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(1, ORDER_COMPUTE_UNIT_LIMIT, true);
  const budget = { programAddress: address("ComputeBudget111111111111111111111111111111"),
    accounts: [], data: budgetData } satisfies Instruction;
  signal.throwIfAborted();
  if (sender.address !== wallet) throw new Error("Wallet changed during replacement preparation");
  const instructions = Object.freeze([budget, cancel.instruction, place.instruction] as const);
  const message = pipe(createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    tx => appendTransactionMessageInstructions(instructions, tx));
  return Object.freeze({ message, instructions, sender: wallet, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash, market: snapshot.market, book: orderBook.book,
    orderId: original.id, replacementOrderId: orderBook.nextSequence,
    outcome: original.outcome, action: original.action, price: input.price, quantity: input.quantity,
    expiresAt: replacementExpiry, expectedNonce: seat.nextNonce, observedSlot: snapshot.finalizedSlot,
    bookRevision: orderBook.revision, lifetime, requiredCash, availableCashAfterCancel, availablePosition });
}
