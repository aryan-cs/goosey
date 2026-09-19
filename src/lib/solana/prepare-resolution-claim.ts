import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type TransactionSigner } from "@solana/kit";
import { deriveGooseySeatAddresses } from "./escrow-client";
import { readGooseyEscrow } from "./escrow-read";
import { buildClaimResolutionInstruction } from "./resolution-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

/** Unsigned permissionless claim. Payer funds receipt rent and transaction fees;
 * proceeds can only credit the target's canonical seat, never the payer's wallet.
 * Finalized observations are advisory: a concurrent claim/finalization can still
 * invalidate execution. No automatic refresh, signing, submission or withdrawal.
 */
export async function prepareResolutionClaim(input: {
  runtime: SolanaRuntime; payer: TransactionSigner; targetWallet: Address; marketId: bigint; signal?: AbortSignal;
}) {
  // Capture caller-controlled inputs before the first await.
  const suppliedRuntime = { ...input.runtime }, payer = input.payer, marketId = input.marketId;
  const targetWallet = address(input.targetWallet), signal = input.signal ?? AbortSignal.timeout(15_000);
  assertIsTransactionSigner(payer);
  const payerAddress = address(payer.address);
  if (typeof marketId !== "bigint" || marketId < 0n || marketId >= 1n << 64n) throw new Error("Invalid claim market ID");
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: suppliedRuntime.cluster,
    GOOSEY_SOLANA_RPC_URL: suppliedRuntime.rpcUrl, GOOSEY_SOLANA_PROGRAM_ID: suppliedRuntime.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: suppliedRuntime.genesisHash });
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: targetWallet },
    { rpc, signal, includeResolution: true });
  if (!snapshot.registered || !snapshot.seat || snapshot.wallet !== targetWallet
    || !snapshot.orderBook?.reservesReconciled) throw new Error("Missing verified target claim seat/book");
  if (!snapshot.resolution || snapshot.resolution.phase !== 3) throw new Error("Claim requires Resolved phase");
  if (typeof snapshot.finalizedSlot !== "bigint" || snapshot.finalizedSlot < 0n) throw new Error("Invalid finalized claim slot");
  const seatIndex = snapshot.seat.index;
  const canonical = await deriveGooseySeatAddresses({ programAddress: runtime.programAddress, marketId, wallet: targetWallet });
  const plan = await buildClaimResolutionInstruction({ programAddress: runtime.programAddress, marketId,
    payer, seats: snapshot.seats, seatIndex });
  if (snapshot.locator !== canonical.locator || snapshot.market !== canonical.market || snapshot.config !== canonical.config
    || plan.market !== snapshot.market || plan.vault !== snapshot.vault || plan.book !== snapshot.orderBook.book
    || snapshot.orderBook.market !== plan.market || snapshot.orderBook.seats !== snapshot.seats
    || snapshot.marketState.seats !== snapshot.seats || plan.resolution !== snapshot.resolution.address
    || snapshot.resolution.market !== plan.market || payer.address !== payerAddress) throw new Error("Claim snapshot bindings changed");
  const receipt = await rpc.getAccountInfo(plan.receipt, { commitment: "finalized", encoding: "base64",
    minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof receipt.context.slot !== "bigint" || receipt.context.slot < snapshot.finalizedSlot) throw new Error("Invalid finalized claim receipt slot");
  if (receipt.value !== null) throw new Error("Claim receipt already exists; refresh resolution state");
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during claim preparation");
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: receipt.context.slot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < receipt.context.slot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid claim signing lifetime");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (payer.address !== payerAddress) throw new Error("Payer changed during claim preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(payer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
  const prepared = { message, sender: payerAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, payer: payerAddress, targetWallet, seatIndex, market: plan.market, seats: snapshot.seats,
    resolution: plan.resolution, receipt: plan.receipt, observedSlot: snapshot.finalizedSlot,
    receiptObservedSlot: receipt.context.slot, lifetime };
}
