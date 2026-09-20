import {
  address, assertIsTransactionSigner, blockhash, appendTransactionMessageInstructions, createSolanaRpc, createTransactionMessage,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, type Instruction, type TransactionSigner,
} from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import { buildPlaceOrderInstruction, type ChainOrderInput } from "./exchange-client";
import { buyOrderReserve } from "./order-reserve";
import type { SolanaRuntime } from "./runtime";

export const ORDER_COMPUTE_UNIT_LIMIT = 1_400_000;
export type PrepareOrderInput = Pick<ChainOrderInput, "marketId" | "price" | "quantity" | "outcome" | "action" |
  "timeInForce" | "selfTrade" | "postOnly" | "expiresAt" | "touches"> & {
  runtime: SolanaRuntime; sender: TransactionSigner; signal?: AbortSignal;
};

/** Unsigned v0 message only. Uses one verified finalized escrow+book snapshot;
 * cash/position sufficiency is advisory, not a fill quote or execution guarantee.
 * No local Date is used to assert market-open/expiry: the execution's real Clock
 * remains authoritative. Nonce and heap/book state can race after preparation.
 * No signing, sending, priority fee, SOL funding, or confirmation is performed.
 */
export async function prepareOrder(input: PrepareOrderInput) {
  const runtime = { ...input.runtime }, sender = input.sender;
  assertIsTransactionSigner(sender);
  const senderAddress = address(sender.address);
  const order = { marketId: input.marketId, price: input.price, quantity: input.quantity, outcome: input.outcome,
    action: input.action, timeInForce: input.timeInForce, selfTrade: input.selfTrade,
    postOnly: input.postOnly, expiresAt: input.expiresAt, touches: input.touches };
  if (typeof order.price !== "bigint" || order.price <= 0n || order.price >= 1_000_000n
    || typeof order.quantity !== "bigint" || order.quantity <= 0n || order.quantity > 10_000_000n) throw new Error("Invalid order price/quantity");
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId: order.marketId, wallet: senderAddress }, { rpc, signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true });
  signal.throwIfAborted();
  if (!snapshot.registered || !snapshot.seat) throw new Error("Register a market seat before placing orders");
  if (!snapshot.resolution || snapshot.resolution.phase !== 0) throw new Error("Market resolution is missing or no longer open");
  const terms = snapshot.marketTerms, resolution = snapshot.resolution;
  if (!terms || terms.sealed !== true || terms.acceptanceBits !== 3) throw new Error("Market terms require sealing and both reviewer acceptances");
  if (terms.market !== snapshot.market || terms.creator !== resolution.creator
    || terms.proposer.wallet !== resolution.proposer.wallet || terms.proposer.enrollment !== resolution.proposer.enrollment
    || terms.approver.wallet !== resolution.approver.wallet || terms.approver.enrollment !== resolution.approver.enrollment) {
    throw new Error("Market terms and frozen resolution reviewers mismatch");
  }
  if (senderAddress === terms.proposer.wallet || senderAddress === terms.approver.wallet) throw new Error("Designated reviewer wallets cannot trade this market");
  if (!snapshot.orderBook?.reservesReconciled || snapshot.wallet !== senderAddress
    || typeof snapshot.finalizedSlot !== "bigint" || snapshot.finalizedSlot < 0n) throw new Error("Missing or mismatched verified order snapshot");
  const { seat, marketState, orderBook } = snapshot;
  if (order.price >= marketState.payoutMilli) throw new Error("Order price must be below the market payout");
  // The shipping builder validates enums, expiry representation, quantity/options,
  // and nonce. Its last arguments override any untrusted extra input properties.
  const plan = await buildPlaceOrderInstruction({ ...order, programAddress: runtime.programAddress,
    wallet: sender, seats: snapshot.seats, expectedNonce: seat.nextNonce });
  if (sender.address !== senderAddress || plan.market !== snapshot.market || plan.config !== snapshot.config
    || plan.vault !== snapshot.vault || plan.locator !== snapshot.locator || plan.book !== orderBook.book || plan.resolution !== snapshot.resolution.address || plan.terms !== terms.address
    || orderBook.market !== snapshot.market || orderBook.seats !== snapshot.seats
    || orderBook.payoutMilli !== marketState.payoutMilli || orderBook.feeBps !== marketState.feeBps) throw new Error("Order snapshot bindings changed");
  // New place_order starts chain_notional=0. This is a conservative full-limit
  // reserve check even for IOC/FOK, not a prediction of matching price/improvement.
  const requiredCash = order.action === "BUY" ? buyOrderReserve({
    limitPriceMilli: order.price,
    quantity: order.quantity,
    feeBps: marketState.feeBps,
  }).requiredCash : 0n;
  const availablePosition = order.outcome === "YES" ? seat.yes - seat.reservedYes : seat.no - seat.reservedNo;
  if (order.action === "BUY" && seat.availableCash < requiredCash) throw new Error("Insufficient finalized available escrow cash for limit reserve");
  if (order.action === "SELL" && availablePosition < order.quantity) throw new Error("Insufficient finalized unreserved outcome positions");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during order preparation");
  signal.throwIfAborted();
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < snapshot.finalizedSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid or stale finalized blockhash response");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  // ComputeBudget::SetComputeUnitLimit = enum tag 2 followed by LE u32. A
  // conservative ceiling accommodates bounded 16-touch matching; not CU proof.
  const budgetData = new Uint8Array(5); budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(1, ORDER_COMPUTE_UNIT_LIMIT, true);
  const budget = { programAddress: address("ComputeBudget111111111111111111111111111111"), accounts: [], data: budgetData } satisfies Instruction;
  signal.throwIfAborted();
  if (sender.address !== senderAddress) throw new Error("Wallet changed during order preparation");
  const message = pipe(createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    tx => appendTransactionMessageInstructions([budget, plan.instruction], tx));
  return { message, instructions: Object.freeze([budget, plan.instruction] as const), sender: senderAddress,
    cluster: runtime.cluster, genesisHash: runtime.genesisHash,
    market: plan.market, book: plan.book, seats: snapshot.seats, expectedNonce: seat.nextNonce,
    observedSlot: snapshot.finalizedSlot, blockhashSlot: latest.context.slot, lifetime, bookRevision: orderBook.revision,
    requiredCash, availableCash: seat.availableCash, availablePosition, computeUnitLimit: ORDER_COMPUTE_UNIT_LIMIT,
    clockChecks: "on-chain-only" as const };
}
