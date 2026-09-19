import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, getAddressEncoder, getProgramDerivedAddress, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, type TransactionSigner } from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import { buildDepositInstruction, buildWithdrawInstruction } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import type { SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

export type PrepareEscrowInput = {
  runtime: SolanaRuntime; sender: TransactionSigner; marketId: bigint; amount: bigint; signal?: AbortSignal;
};
const MAX = (1n << 64n) - 1n;
function uint(value: bigint, name: string, minimum = 0n) {
  if (typeof value !== "bigint" || value < minimum || value > MAX) throw new Error(`Invalid ${name}`);
  return value;
}

/** Unsigned owner-only transfer preparation, not execution or a balance promise.
 * The finalized reader verifies phase-aware backing AND full-book reserves in
 * one snapshot. Resolved/finalized markets remain withdrawable; do not substitute
 * pre-resolution YES==NO backing checks or gate cash transfers on market-open.
 * ATA must already exist. No automatic creation, signing, sending, nonce retry,
 * SOL funding assurance, DB mutation or manufactured settlement proceeds.
 */
async function prepare(input: PrepareEscrowInput, direction: "deposit" | "withdrawal") {
  const runtime = { ...input.runtime }, sender = input.sender;
  const marketId = uint(input.marketId, "market ID"), amount = uint(input.amount, "amount", 1n);
  assertIsTransactionSigner(sender);
  const senderAddress = address(sender.address), signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: senderAddress },
    { rpc, signal, includeResolution: true });
  signal.throwIfAborted();
  if (!snapshot.registered || !snapshot.seat || !snapshot.resolution || !snapshot.orderBook?.reservesReconciled
    || snapshot.wallet !== senderAddress || typeof snapshot.finalizedSlot !== "bigint" || snapshot.finalizedSlot < 0n) {
    throw new Error("Missing or mismatched verified escrow snapshot");
  }
  if (snapshot.walletTokenAmount === null) throw new Error("Wallet feather token account must already exist");
  const walletTokenAmount = uint(snapshot.walletTokenAmount, "wallet SPL balance");
  const availableCash = uint(snapshot.seat.availableCash, "available escrow cash");
  const reservedCash = uint(snapshot.seat.reservedCash, "reserved escrow cash");
  const accounted = uint(snapshot.marketState.accountedVault, "accounted vault");
  const vaultAmount = uint(snapshot.vaultAmount, "vault balance");
  const expectedNonce = uint(snapshot.seat.nextNonce, "nonce");
  if (direction === "deposit") {
    if (amount > walletTokenAmount) throw new Error("Insufficient finalized wallet SPL feathers");
    if (availableCash + amount > MAX || accounted + amount > MAX || vaultAmount + amount > MAX) throw new Error("Escrow deposit would overflow");
  } else {
    // availableCash already EXCLUDES reservedCash. Neither reservations, surplus,
    // positions nor pending claims can fund this withdrawal.
    if (amount > availableCash) throw new Error("Insufficient finalized unreserved escrow cash");
    if (amount > accounted || amount > vaultAmount || walletTokenAmount + amount > MAX) throw new Error("Invalid withdrawal backing or overflow");
  }
  const plan = await (direction === "deposit" ? buildDepositInstruction : buildWithdrawInstruction)({
    programAddress: runtime.programAddress, marketId, wallet: sender, seats: snapshot.seats, amount, expectedNonce,
  });
  const [{ book }, [resolution]] = await Promise.all([
    deriveGooseyBookAddress(runtime.programAddress, plan.market),
    getProgramDerivedAddress({ programAddress: runtime.programAddress, seeds: ["resolution", getAddressEncoder().encode(plan.market)] }),
  ]);
  if (sender.address !== senderAddress || plan.market !== snapshot.market || plan.config !== snapshot.config
    || plan.vault !== snapshot.vault || plan.locator !== snapshot.locator || plan.featherMint !== snapshot.featherMint
    || plan.walletTokens !== snapshot.walletTokens || plan.enrollment !== snapshot.enrollment
    || snapshot.marketState.seats !== snapshot.seats || snapshot.marketState.marketId !== marketId
    || snapshot.orderBook.book !== book || snapshot.orderBook.market !== plan.market || snapshot.orderBook.seats !== snapshot.seats
    || snapshot.resolution.address !== resolution) throw new Error("Escrow snapshot bindings changed");
  signal.throwIfAborted();
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during escrow preparation");
  signal.throwIfAborted();
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < snapshot.finalizedSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid or stale finalized blockhash response");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (sender.address !== senderAddress) throw new Error("Wallet changed during escrow preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
  const prepared = { message, sender: senderAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, direction, amount, market: plan.market, seats: snapshot.seats, vault: plan.vault,
    walletTokens: plan.walletTokens, expectedNonce, observedSlot: snapshot.finalizedSlot, blockhashSlot: latest.context.slot,
    lifetime, availableCash, reservedCash, walletTokenAmount };
}
export const prepareEscrowDeposit = (input: PrepareEscrowInput) => prepare(input, "deposit");
export const prepareEscrowWithdrawal = (input: PrepareEscrowInput) => prepare(input, "withdrawal");
