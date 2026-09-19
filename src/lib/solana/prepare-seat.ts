import { address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, getAddressDecoder, getAddressEncoder, getBase64Decoder, getBase64Encoder,
  getProgramDerivedAddress, pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner } from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import { buildRegisterSeatInstruction } from "./escrow-client";
import { deriveGooseyBookAddress } from "./exchange-client";
import { deriveGooseyMarketTermsAddresses } from "./market-terms-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

export type PrepareMarketSeatInput = {
  runtime: SolanaRuntime; sender: TransactionSigner; marketId: bigint; signal?: AbortSignal;
};

/** Unsigned seat registration only. Registration is permanent and the program
 * permits closed markets/reviewers and expired or already-claimed grants; those
 * are not registration restrictions. Actual enrollment is required. Capacity,
 * concurrent registration and SOL rent/fees remain execution-time checks.
 * No ATA creation, grant, deposit, signing, sending or funding is performed.
 */
export async function prepareMarketSeat(input: PrepareMarketSeatInput) {
  const supplied = { ...input.runtime }, sender = input.sender, marketId = input.marketId;
  if (typeof marketId !== "bigint" || marketId < 0n || marketId > (1n << 64n) - 1n) throw new Error("Invalid market ID");
  assertIsTransactionSigner(sender);
  const senderAddress = address(sender.address), signal = input.signal ?? AbortSignal.timeout(15_000);
  const runtime = resolveSolanaRuntime({ GOOSEY_SOLANA_CLUSTER: supplied.cluster, GOOSEY_SOLANA_RPC_URL: supplied.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: supplied.programAddress, GOOSEY_SOLANA_GENESIS_HASH: supplied.genesisHash });
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: senderAddress },
    { rpc, signal, includeResolution: true, includeMarketTerms: true });
  signal.throwIfAborted();
  if (snapshot.registered === true || snapshot.seat !== null) throw new Error("Wallet already has a market seat");
  if (snapshot.registered !== false || snapshot.wallet !== senderAddress || !snapshot.resolution || !snapshot.marketTerms
    || !snapshot.orderBook?.reservesReconciled || typeof snapshot.finalizedSlot !== "bigint" || snapshot.finalizedSlot < 0n) {
    throw new Error("Missing or mismatched verified seat snapshot");
  }
  if (!Array.isArray(snapshot.orderBook.seatReserves) || snapshot.orderBook.seatReserves.length >= 256) throw new Error("Market seat capacity unavailable");
  const plan = await buildRegisterSeatInstruction({ programAddress: runtime.programAddress, marketId, wallet: sender, seats: snapshot.seats });
  const [{ book }, { terms }, [resolution]] = await Promise.all([
    deriveGooseyBookAddress(runtime.programAddress, plan.market),
    deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId }),
    getProgramDerivedAddress({ programAddress: runtime.programAddress, seeds: ["resolution", getAddressEncoder().encode(plan.market)] }),
  ]);
  if (sender.address !== senderAddress || plan.config !== snapshot.config || plan.market !== snapshot.market
    || plan.enrollment !== snapshot.enrollment || plan.locator !== snapshot.locator || plan.vault !== snapshot.vault
    || plan.featherMint !== snapshot.featherMint || plan.walletTokens !== snapshot.walletTokens
    || plan.seats !== snapshot.seats || snapshot.marketState.seats !== snapshot.seats || snapshot.marketState.marketId !== marketId
    || snapshot.orderBook.book !== book || snapshot.orderBook.market !== plan.market || snapshot.orderBook.seats !== snapshot.seats
    || snapshot.resolution.address !== resolution || snapshot.marketTerms.address !== terms || snapshot.marketTerms.market !== plan.market
    || snapshot.marketTerms.creator !== snapshot.resolution.creator
    || snapshot.marketTerms.proposer.wallet !== snapshot.resolution.proposer.wallet
    || snapshot.marketTerms.proposer.enrollment !== snapshot.resolution.proposer.enrollment
    || snapshot.marketTerms.approver.wallet !== snapshot.resolution.approver.wallet
    || snapshot.marketTerms.approver.enrollment !== snapshot.resolution.approver.enrollment) throw new Error("Seat snapshot bindings changed");
  // Enrollment is not included by the financial reader. Verify its actual
  // finalized account at or after that snapshot, without mixing in balances.
  const enrollment = await rpc.getAccountInfo(plan.enrollment, { encoding: "base64", commitment: "finalized",
    minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof enrollment.context.slot !== "bigint" || enrollment.context.slot < snapshot.finalizedSlot) throw new Error("Invalid finalized enrollment context");
  const account = enrollment.value;
  if (!account || account.owner !== runtime.programAddress || account.executable !== false || !Array.isArray(account.data)
    || account.data.length !== 2 || account.data[1] !== "base64" || typeof account.data[0] !== "string"
    || account.data[0].length !== 172) throw new Error("Missing or invalid on-chain enrollment");
  const bytes = new Uint8Array(getBase64Encoder().encode(account.data[0]));
  const discriminator = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("account:Enrollment")));
  if (bytes.length !== 129 || getBase64Decoder().decode(bytes) !== account.data[0]
    || !bytes.subarray(0, 8).every((byte, i) => byte === discriminator[i])
    || getAddressDecoder().decode(bytes.subarray(8, 40)) !== plan.config
    || getAddressDecoder().decode(bytes.subarray(40, 72)) !== senderAddress
    || bytes[128] !== plan.enrollmentBump) throw new Error("Invalid enrollment account binding");
  signal.throwIfAborted();
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) throw new Error("Solana RPC genesis changed during seat preparation");
  signal.throwIfAborted();
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: enrollment.context.slot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < enrollment.context.slot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) throw new Error("Invalid or stale finalized blockhash response");
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (sender.address !== senderAddress) throw new Error("Wallet changed during seat preparation");
  const message = pipe(createTransactionMessage({ version: 0 }), tx => setTransactionMessageFeePayerSigner(sender, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx), tx => appendTransactionMessageInstructions([plan.instruction], tx));
  const prepared = { message, sender: senderAddress, cluster: runtime.cluster, genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, market: plan.market, seats: plan.seats, enrollment: plan.enrollment, locator: plan.locator,
    observedSlot: snapshot.finalizedSlot, enrollmentSlot: enrollment.context.slot, blockhashSlot: latest.context.slot, lifetime };
}
