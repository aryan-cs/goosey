import {
  address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, pipe, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, type Address, type TransactionSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { readGooseyEscrow } from "./escrow-read";
import {
  buildCloseResolutionInstruction, buildFinalizeResolutionInstruction,
} from "./resolution-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const U64_LIMIT = 1n << 64n;
const I64_LIMIT = 1n << 63n;

type KeeperOperation = "CLOSE_RESOLUTION" | "FINALIZE_RESOLUTION";
type Snapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;

function pinnedRuntime(value: SolanaRuntime) {
  return resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: value.cluster,
    GOOSEY_SOLANA_RPC_URL: value.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: value.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: value.genesisHash,
  });
}

function validMarketId(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value >= U64_LIMIT) {
    throw new Error("Invalid resolution keeper market ID");
  }
  return value;
}

function assertKeeper(keeper: TransactionSigner, captured: Address) {
  if (keeper.address !== captured) throw new Error("Keeper wallet changed during preparation");
}

function verifyBoundSnapshot(snapshot: Snapshot, keeper: Address) {
  const book = snapshot.orderBook;
  const resolution = snapshot.resolution;
  const terms = snapshot.marketTerms;
  if (snapshot.wallet !== keeper || typeof snapshot.finalizedSlot !== "bigint"
    || snapshot.finalizedSlot < 0n || snapshot.finalizedSlot >= U64_LIMIT
    || !book?.reservesReconciled || !resolution || !terms) {
    throw new Error("Missing verified finalized resolution keeper snapshot");
  }
  if (snapshot.marketState.seats !== snapshot.seats || book.market !== snapshot.market
    || book.seats !== snapshot.seats || book.payoutMilli !== snapshot.marketState.payoutMilli
    || book.feeBps !== snapshot.marketState.feeBps || resolution.market !== snapshot.market
    || resolution.creator !== snapshot.marketState.creator || terms.market !== snapshot.market
    || terms.creator !== snapshot.marketState.creator || terms.proposer.wallet !== resolution.proposer.wallet
    || terms.proposer.enrollment !== resolution.proposer.enrollment
    || terms.approver.wallet !== resolution.approver.wallet
    || terms.approver.enrollment !== resolution.approver.enrollment) {
    throw new Error("Resolution keeper snapshot bindings mismatch");
  }
  if (resolution.proposer.wallet === SYSTEM_PROGRAM_ADDRESS
    || resolution.approver.wallet === SYSTEM_PROGRAM_ADDRESS
    || resolution.proposer.wallet === resolution.approver.wallet
    || resolution.proposer.wallet === resolution.creator
    || resolution.approver.wallet === resolution.creator) {
    throw new Error("Resolution keeper reviewer bindings conflict");
  }
  if (!terms.sealed || terms.acceptanceBits !== 3) {
    throw new Error("Resolution keeper requires sealed, fully accepted market terms");
  }
  return { book, resolution, terms };
}

function verifyDrainedBook(book: NonNullable<Snapshot["orderBook"]>) {
  if (book.orders.length !== 0 || book.seatReserves.some(row => row.reservedCash !== 0n
    || row.reservedYes !== 0n || row.reservedNo !== 0n)) {
    throw new Error("Resolution keeper requires all orders and reserves to be cleared");
  }
}

function verifyCloseState(snapshot: Snapshot, verified: ReturnType<typeof verifyBoundSnapshot>) {
  if (verified.resolution.phase !== 0 || verified.resolution.activeProposalSequence !== null
    || verified.resolution.outcome !== null) {
    throw new Error("Resolution close requires Open phase");
  }
  verifyDrainedBook(verified.book);
  const yes = verified.book.seatReserves.reduce((sum, row) => sum + row.yes, 0n);
  const no = verified.book.seatReserves.reduce((sum, row) => sum + row.no, 0n);
  if (yes !== no || yes * snapshot.marketState.payoutMilli !== snapshot.marketState.collateral) {
    throw new Error("Resolution close liabilities do not reconcile");
  }
}

function verifyFinalizeState(snapshot: Snapshot, verified: ReturnType<typeof verifyBoundSnapshot>) {
  const { resolution, book } = verified;
  if (resolution.phase !== 3 || resolution.activeProposalSequence !== null || resolution.outcome === null) {
    throw new Error("Resolution finalize requires Resolved phase");
  }
  verifyDrainedBook(book);
  const positionsRemain = book.seatReserves.some(row => row.yes !== 0n || row.no !== 0n);
  if (resolution.outstandingYes !== 0n || resolution.outstandingNo !== 0n || positionsRemain) {
    throw new Error("Resolution finalize requires all position claims and liabilities to be cleared");
  }
  if (resolution.outcome !== 2 && snapshot.marketState.collateral !== 0n) {
    throw new Error("Non-VOID resolution retains collateral liability");
  }
}

async function signingLifetime(
  rpc: ReturnType<typeof createSolanaRpc>, runtime: SolanaRuntime, observedSlot: bigint,
  keeper: TransactionSigner, keeperAddress: Address, signal: AbortSignal,
) {
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during resolution keeper preparation");
  }
  signal.throwIfAborted();
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot: observedSlot })
    .send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < observedSlot
    || latest.context.slot >= U64_LIMIT || typeof latest.value.lastValidBlockHeight !== "bigint"
    || latest.value.lastValidBlockHeight < 0n || latest.value.lastValidBlockHeight >= U64_LIMIT) {
    throw new Error("Invalid or stale resolution keeper signing lifetime");
  }
  const lifetime = {
    blockhash: blockhash(latest.value.blockhash),
    lastValidBlockHeight: latest.value.lastValidBlockHeight,
  };
  signal.throwIfAborted();
  assertKeeper(keeper, keeperAddress);
  return { lifetime, blockhashSlot: latest.context.slot };
}

function walletMessage(
  keeper: TransactionSigner,
  lifetime: Awaited<ReturnType<typeof signingLifetime>>["lifetime"],
  instruction: Awaited<ReturnType<typeof buildCloseResolutionInstruction>>["instruction"],
) {
  return pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(keeper, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    tx => appendTransactionMessageInstructions([instruction], tx),
  );
}

async function prepare(input: {
  operation: KeeperOperation; runtime: SolanaRuntime; keeper: TransactionSigner;
  marketId: bigint; signal?: AbortSignal;
}) {
  const runtime = pinnedRuntime({ ...input.runtime });
  const keeper = input.keeper;
  const marketId = validMarketId(input.marketId);
  assertIsTransactionSigner(keeper);
  const keeperAddress = address(keeper.address);
  if (keeperAddress === SYSTEM_PROGRAM_ADDRESS) throw new Error("Keeper wallet must be nonzero");
  const signal = input.signal ?? AbortSignal.timeout(15_000);
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId, wallet: keeperAddress }, {
    rpc, signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true,
  });
  signal.throwIfAborted();
  assertKeeper(keeper, keeperAddress);
  const verified = verifyBoundSnapshot(snapshot, keeperAddress);

  let observedChainTime: bigint | null = null;
  if (input.operation === "CLOSE_RESOLUTION") {
    verifyCloseState(snapshot, verified);
    observedChainTime = await rpc.getBlockTime(snapshot.finalizedSlot).send({ abortSignal: signal });
    if (typeof observedChainTime !== "bigint" || observedChainTime < -I64_LIMIT
      || observedChainTime >= I64_LIMIT) throw new Error("Missing or malformed finalized on-chain close time");
    if (observedChainTime < snapshot.marketState.closesAt) {
      throw new Error("Resolution cannot close before the finalized on-chain close time");
    }
  } else {
    verifyFinalizeState(snapshot, verified);
  }
  signal.throwIfAborted();
  assertKeeper(keeper, keeperAddress);

  const plan = input.operation === "CLOSE_RESOLUTION"
    ? await buildCloseResolutionInstruction({ programAddress: runtime.programAddress, marketId,
      seats: snapshot.seats, keeper })
    : await buildFinalizeResolutionInstruction({ programAddress: runtime.programAddress, marketId,
      seats: snapshot.seats, keeper });
  assertKeeper(keeper, keeperAddress);
  if (plan.config !== snapshot.config || plan.market !== snapshot.market
    || plan.book !== verified.book.book || plan.resolution !== verified.resolution.address
    || plan.vault !== snapshot.vault) throw new Error("Resolution keeper instruction bindings changed");

  const signing = await signingLifetime(rpc, runtime, snapshot.finalizedSlot,
    keeper, keeperAddress, signal);
  const message = walletMessage(keeper, signing.lifetime, plan.instruction);
  const prepared = { message, sender: keeperAddress, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return {
    ...prepared, operation: input.operation, keeper: keeperAddress, market: snapshot.market,
    seats: snapshot.seats, book: verified.book.book, resolution: verified.resolution.address,
    terms: verified.terms.address, vault: snapshot.vault,
    expectedPhase: input.operation === "CLOSE_RESOLUTION" ? 0 as const : 3 as const,
    expectedNextPhase: input.operation === "CLOSE_RESOLUTION" ? 1 as const : 4 as const,
    expectedBookRevision: verified.book.revision, observedSlot: snapshot.finalizedSlot,
    blockhashSlot: signing.blockhashSlot, lifetime: signing.lifetime,
    closesAt: snapshot.marketState.closesAt, observedChainTime,
  };
}

/** Prepare a permissionless Open -> Closed transition. Eligibility is based on
 * finalized chain time for the exact coherent financial snapshot, never local
 * wall-clock time. The returned v0 message is unsigned and is not submitted. */
export function prepareResolutionClose(input: {
  runtime: SolanaRuntime; keeper: TransactionSigner; marketId: bigint; signal?: AbortSignal;
}) {
  return prepare({ ...input, operation: "CLOSE_RESOLUTION" });
}

/** Prepare a permissionless Resolved -> Finalized transition only after the
 * coherent reader proves the book, reserves, positions and liabilities drained.
 * The returned v0 message is unsigned and is not submitted. */
export function prepareResolutionFinalize(input: {
  runtime: SolanaRuntime; keeper: TransactionSigner; marketId: bigint; signal?: AbortSignal;
}) {
  return prepare({ ...input, operation: "FINALIZE_RESOLUTION" });
}
