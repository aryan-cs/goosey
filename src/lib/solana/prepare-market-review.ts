import {
  address, assertIsTransactionSigner, appendTransactionMessageInstructions, blockhash, createSolanaRpc,
  createTransactionMessage, getAddressDecoder, getBase64Decoder, getBase64Encoder, getProgramDerivedAddress, getAddressEncoder,
  pipe, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type TransactionSigner,
} from "@solana/kit";
import { readGooseyEscrow } from "./escrow-read";
import {
  buildAcceptMarketTermsInstruction, buildSealMarketTermsInstruction, deriveGooseyMarketTermsAddresses,
  readMarketTermsAccount, MARKET_TERMS_ACCOUNT_BYTES,
} from "./market-terms-client";
import {
  buildApproveResolutionInstruction, buildProposeResolutionInstruction, buildRejectResolutionInstruction,
  type ResolutionFingerprint, type ResolutionOutcome,
} from "./resolution-client";
import { resolveSolanaRuntime, type SolanaRuntime } from "./runtime";
import type { PreparedWalletTransaction } from "./wallet-transaction";

const U64_LIMIT = 1n << 64n;
const PROPOSAL_ACCOUNT_BYTES = 293;
const ZERO = "11111111111111111111111111111111";

type ReviewRole = "proposer" | "approver";
type ReviewDecision =
  | { decision: "APPROVE" }
  | { decision: "REJECT"; reviewDigestSha256: Uint8Array };

function marketId(value: bigint) {
  if (typeof value !== "bigint" || value < 0n || value >= U64_LIMIT) throw new Error("Invalid review market ID");
  return value;
}

function sha256Digest(value: Uint8Array, label: string) {
  if (!(value instanceof Uint8Array) || value.length !== 32 || !value.some(Boolean)) {
    throw new Error(`${label} must be a nonzero 32-byte SHA-256 digest`);
  }
  return new Uint8Array(value);
}

function runtimeOf(value: SolanaRuntime) {
  return resolveSolanaRuntime({
    GOOSEY_SOLANA_CLUSTER: value.cluster,
    GOOSEY_SOLANA_RPC_URL: value.rpcUrl,
    GOOSEY_SOLANA_PROGRAM_ID: value.programAddress,
    GOOSEY_SOLANA_GENESIS_HASH: value.genesisHash,
  });
}

function copyFingerprint(value: ResolutionFingerprint): ResolutionFingerprint {
  const outcome: ResolutionOutcome = value.outcome;
  if (outcome !== "YES" && outcome !== "NO" && outcome !== "VOID") throw new Error("Invalid resolution outcome");
  if (typeof value.sequence !== "bigint" || value.sequence <= 0n || value.sequence >= U64_LIMIT) {
    throw new Error("Invalid resolution sequence");
  }
  return { sequence: value.sequence, outcome,
    reasonDigest: sha256Digest(value.reasonDigest, "Reason digest"),
    evidenceDigest: sha256Digest(value.evidenceDigest, "Evidence digest") };
}

function bytesFromRpc(value: unknown, size: number) {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || value[1] !== "base64") {
    throw new Error("Invalid finalized review account encoding");
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(value[0]));
  if (bytes.length !== size || getBase64Decoder().decode(bytes) !== value[0]) {
    throw new Error("Invalid finalized review account size or noncanonical base64");
  }
  return bytes;
}

async function accountDiscriminator(name: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`account:${name}`))).slice(0, 8);
}

function assertSnapshotBindings(snapshot: Awaited<ReturnType<typeof readGooseyEscrow>>, signer: Address) {
  const book = snapshot.orderBook;
  if (snapshot.wallet !== signer || !book?.reservesReconciled || book.market !== snapshot.market
    || book.book === ZERO || book.seats !== snapshot.seats || typeof snapshot.finalizedSlot !== "bigint"
    || snapshot.finalizedSlot < 0n) throw new Error("Missing or mismatched verified review snapshot");
  return book;
}

function assertFrozenBindings(snapshot: Awaited<ReturnType<typeof readGooseyEscrow>>) {
  const terms = snapshot.marketTerms, resolution = snapshot.resolution;
  if (!terms || !resolution || terms.market !== snapshot.market || terms.creator !== snapshot.marketState.creator
    || resolution.market !== snapshot.market || resolution.creator !== snapshot.marketState.creator
    || terms.proposer.wallet !== resolution.proposer.wallet || terms.proposer.enrollment !== resolution.proposer.enrollment
    || terms.approver.wallet !== resolution.approver.wallet || terms.approver.enrollment !== resolution.approver.enrollment) {
    throw new Error("Market terms and resolution reviewer bindings mismatch");
  }
  return { terms, resolution };
}

async function signingLifetime(
  rpc: ReturnType<typeof createSolanaRpc>, runtime: SolanaRuntime, minContextSlot: bigint,
  signer: TransactionSigner, capturedSigner: Address, signal: AbortSignal,
) {
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("Solana RPC genesis changed during market review preparation");
  }
  const latest = await rpc.getLatestBlockhash({ commitment: "finalized", minContextSlot }).send({ abortSignal: signal });
  if (typeof latest.context.slot !== "bigint" || latest.context.slot < minContextSlot
    || typeof latest.value.lastValidBlockHeight !== "bigint" || latest.value.lastValidBlockHeight < 0n) {
    throw new Error("Invalid or stale market review signing lifetime");
  }
  const lifetime = { blockhash: blockhash(latest.value.blockhash), lastValidBlockHeight: latest.value.lastValidBlockHeight };
  signal.throwIfAborted();
  if (signer.address !== capturedSigner) throw new Error("Review wallet changed during preparation");
  return { lifetime, blockhashSlot: latest.context.slot };
}

function walletMessage(signer: TransactionSigner, lifetime: Awaited<ReturnType<typeof signingLifetime>>["lifetime"], instruction: Parameters<typeof appendTransactionMessageInstructions>[0][number]) {
  return pipe(createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(signer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(lifetime, tx),
    tx => appendTransactionMessageInstructions([instruction], tx));
}

async function readTermsAfterSnapshot(
  rpc: ReturnType<typeof createSolanaRpc>, runtime: SolanaRuntime,
  snapshot: Awaited<ReturnType<typeof readGooseyEscrow>>, signal: AbortSignal,
) {
  const derived = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress,
    marketId: snapshot.marketState.marketId });
  if (derived.market !== snapshot.market || derived.config !== snapshot.config) throw new Error("Noncanonical review market bindings");
  const response = await rpc.getAccountInfo(derived.terms, { commitment: "finalized", encoding: "base64",
    minContextSlot: snapshot.finalizedSlot }).send({ abortSignal: signal });
  if (typeof response.context.slot !== "bigint" || response.context.slot < snapshot.finalizedSlot || !response.value
    || response.value.owner !== runtime.programAddress || response.value.executable !== false) {
    throw new Error("Missing finalized market terms snapshot");
  }
  const bytes = bytesFromRpc(response.value.data, MARKET_TERMS_ACCOUNT_BYTES);
  const decoder = getAddressDecoder();
  const proposer = { wallet: decoder.decode(bytes.subarray(109, 141)), enrollment: decoder.decode(bytes.subarray(141, 173)) };
  const approver = { wallet: decoder.decode(bytes.subarray(173, 205)), enrollment: decoder.decode(bytes.subarray(205, 237)) };
  const terms = await readMarketTermsAccount({ programAddress: runtime.programAddress,
    marketId: snapshot.marketState.marketId, config: snapshot.config, market: snapshot.market,
    creator: snapshot.marketState.creator, proposer, approver },
  { address: derived.terms, owner: response.value.owner, executable: response.value.executable, data: bytes });
  return { terms, termsSlot: response.context.slot };
}

function assertPristineTermsBook(snapshot: Awaited<ReturnType<typeof readGooseyEscrow>>) {
  const book = snapshot.orderBook!;
  if (book.revision !== 0n || book.nextSequence !== 1n || book.orders.length !== 0
    || snapshot.marketState.collateral !== 0n || snapshot.marketState.feeRevenue !== 0n
    || book.seatReserves.some(seat => seat.yes !== 0n || seat.no !== 0n || seat.reservedCash !== 0n
      || seat.reservedYes !== 0n || seat.reservedNo !== 0n || seat.everTraded)) {
    throw new Error("Market is no longer pristine enough for terms review");
  }
}

/** Prepare one designated reviewer's immutable terms acceptance. Resolution is
 * intentionally absent here: the program cannot initialize it until terms are
 * sealed. The finalized market/book read plus a monotonic finalized terms read
 * is the strongest snapshot the current ABI can represent. */
export async function prepareMarketTermsAcceptance(input: {
  runtime: SolanaRuntime; reviewer: TransactionSigner; marketId: bigint;
  expectedDigestSha256: Uint8Array; signal?: AbortSignal;
}) {
  const runtime = runtimeOf({ ...input.runtime }), reviewer = input.reviewer, id = marketId(input.marketId);
  const expectedDigest = sha256Digest(input.expectedDigestSha256, "Expected terms digest");
  assertIsTransactionSigner(reviewer); const reviewerAddress = address(reviewer.address);
  const signal = input.signal ?? AbortSignal.timeout(15_000); signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId: id, wallet: reviewerAddress },
    { rpc, signal, includeOrderBook: true });
  const book = assertSnapshotBindings(snapshot, reviewerAddress); assertPristineTermsBook(snapshot);
  const { terms, termsSlot } = await readTermsAfterSnapshot(rpc, runtime, snapshot, signal);
  if (terms.sealed || !terms.digest.every((value, index) => value === expectedDigest[index])) {
    throw new Error("Terms are sealed or their immutable digest changed");
  }
  const role: ReviewRole | null = terms.proposer.wallet === reviewerAddress ? "proposer"
    : terms.approver.wallet === reviewerAddress ? "approver" : null;
  if (!role) throw new Error("Wallet is not a designated terms reviewer");
  const acceptanceBit = role === "proposer" ? 1 : 2;
  if (terms.acceptanceBits & acceptanceBit) throw new Error("Designated reviewer already accepted these terms");
  const seat = book.seatReserves.find(row => row.wallet === reviewerAddress);
  if (seat?.everTraded) throw new Error("Designated reviewer has market trading history");
  const plan = await buildAcceptMarketTermsInstruction({ programAddress: runtime.programAddress, marketId: id,
    seats: snapshot.seats, reviewer, expectedDigest });
  if (plan.market !== snapshot.market || plan.config !== snapshot.config || plan.book !== book.book
    || plan.terms !== terms.address || plan.reviewerEnrollment !== terms[role].enrollment) throw new Error("Terms acceptance bindings changed");
  const signing = await signingLifetime(rpc, runtime, termsSlot, reviewer, reviewerAddress, signal);
  const message = walletMessage(reviewer, signing.lifetime, plan.instruction);
  const prepared = { message, sender: reviewerAddress, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, operation: "ACCEPT_TERMS" as const, role, market: snapshot.market, terms: terms.address,
    seats: snapshot.seats, reviewerEnrollment: plan.reviewerEnrollment, expectedDigestSha256: expectedDigest,
    expectedAcceptanceBits: terms.acceptanceBits, expectedSealed: false as const,
    financialObservedSlot: snapshot.finalizedSlot, observedSlot: termsSlot, blockhashSlot: signing.blockhashSlot,
    bookRevision: book.revision, lifetime: signing.lifetime };
}

/** Prepare creator sealing only after both immutable reviewers accepted and the
 * verified finalized market remains pristine. */
export async function prepareMarketTermsSeal(input: {
  runtime: SolanaRuntime; creator: TransactionSigner; marketId: bigint;
  expectedDigestSha256: Uint8Array; signal?: AbortSignal;
}) {
  const runtime = runtimeOf({ ...input.runtime }), creator = input.creator, id = marketId(input.marketId);
  const expectedDigest = sha256Digest(input.expectedDigestSha256, "Expected terms digest");
  assertIsTransactionSigner(creator); const creatorAddress = address(creator.address);
  const signal = input.signal ?? AbortSignal.timeout(15_000); signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const snapshot = await readGooseyEscrow(runtime, { marketId: id, wallet: creatorAddress },
    { rpc, signal, includeOrderBook: true });
  const book = assertSnapshotBindings(snapshot, creatorAddress); assertPristineTermsBook(snapshot);
  const { terms, termsSlot } = await readTermsAfterSnapshot(rpc, runtime, snapshot, signal);
  if (creatorAddress !== snapshot.marketState.creator || creatorAddress !== terms.creator) throw new Error("Only the market creator can seal terms");
  if (terms.sealed || terms.acceptanceBits !== 3 || !terms.digest.every((value, index) => value === expectedDigest[index])) {
    throw new Error("Terms require both acceptances, an unsealed state, and the exact immutable digest");
  }
  const plan = await buildSealMarketTermsInstruction({ programAddress: runtime.programAddress, marketId: id,
    seats: snapshot.seats, creator, expectedDigest });
  if (plan.market !== snapshot.market || plan.config !== snapshot.config || plan.book !== book.book || plan.terms !== terms.address) {
    throw new Error("Terms sealing bindings changed");
  }
  const signing = await signingLifetime(rpc, runtime, termsSlot, creator, creatorAddress, signal);
  const message = walletMessage(creator, signing.lifetime, plan.instruction);
  const prepared = { message, sender: creatorAddress, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, operation: "SEAL_TERMS" as const, market: snapshot.market, terms: terms.address,
    seats: snapshot.seats, expectedDigestSha256: expectedDigest, expectedAcceptanceBits: 3 as const,
    expectedSealed: false as const, financialObservedSlot: snapshot.finalizedSlot, observedSlot: termsSlot,
    blockhashSlot: signing.blockhashSlot, bookRevision: book.revision, lifetime: signing.lifetime };
}

async function readFrozenSnapshot(runtime: SolanaRuntime, signer: Address, id: bigint, rpc: ReturnType<typeof createSolanaRpc>, signal: AbortSignal) {
  const snapshot = await readGooseyEscrow(runtime, { marketId: id, wallet: signer },
    { rpc, signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true });
  const book = assertSnapshotBindings(snapshot, signer), frozen = assertFrozenBindings(snapshot);
  if (!frozen.terms.sealed || frozen.terms.acceptanceBits !== 3) throw new Error("Resolution requires sealed, fully accepted market terms");
  return { snapshot, book, ...frozen };
}

/** Prepare the designated proposer's next exact result fingerprint. Digest
 * labels describe the ABI contract; preimages remain an application concern. */
export async function prepareResolutionProposal(input: {
  runtime: SolanaRuntime; proposer: TransactionSigner; marketId: bigint; expectedNextSequence: bigint;
  outcome: ResolutionOutcome; reasonDigestSha256: Uint8Array; evidenceDigestSha256: Uint8Array; signal?: AbortSignal;
}) {
  const runtime = runtimeOf({ ...input.runtime }), proposer = input.proposer, id = marketId(input.marketId);
  const fingerprint = copyFingerprint({ sequence: input.expectedNextSequence, outcome: input.outcome,
    reasonDigest: input.reasonDigestSha256, evidenceDigest: input.evidenceDigestSha256 });
  assertIsTransactionSigner(proposer); const proposerAddress = address(proposer.address);
  const signal = input.signal ?? AbortSignal.timeout(15_000); signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const { snapshot, book, terms, resolution } = await readFrozenSnapshot(runtime, proposerAddress, id, rpc, signal);
  if (resolution.phase !== 1 || resolution.activeProposalSequence !== null
    || resolution.nextProposalSequence !== fingerprint.sequence) throw new Error("Resolution proposal phase or next sequence is stale");
  if (proposerAddress !== resolution.proposer.wallet) throw new Error("Only the designated proposer can propose a result");
  const plan = await buildProposeResolutionInstruction({ programAddress: runtime.programAddress, marketId: id,
    seats: snapshot.seats, reviewer: proposer, ...fingerprint });
  if (plan.market !== snapshot.market || plan.config !== snapshot.config || plan.book !== book.book
    || plan.resolution !== resolution.address || plan.reviewerEnrollment !== resolution.proposer.enrollment) {
    throw new Error("Resolution proposal bindings changed");
  }
  const signing = await signingLifetime(rpc, runtime, snapshot.finalizedSlot, proposer, proposerAddress, signal);
  const message = walletMessage(proposer, signing.lifetime, plan.instruction);
  const prepared = { message, sender: proposerAddress, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, operation: "PROPOSE_RESOLUTION" as const, market: snapshot.market, terms: terms.address,
    resolution: resolution.address, proposal: plan.proposal, seats: snapshot.seats,
    proposerEnrollment: plan.reviewerEnrollment, fingerprint, expectedPhase: 1 as const,
    expectedNextSequence: fingerprint.sequence, expectedActiveProposalSequence: null,
    expectedTermsAcceptanceBits: 3 as const, expectedTermsSealed: true as const,
    designatedProposer: resolution.proposer.wallet, designatedApprover: resolution.approver.wallet,
    observedSlot: snapshot.finalizedSlot, blockhashSlot: signing.blockhashSlot,
    bookRevision: book.revision, lifetime: signing.lifetime };
}

async function readPendingProposal(rpc: ReturnType<typeof createSolanaRpc>, runtime: SolanaRuntime,
  market: Address, fingerprint: ResolutionFingerprint, minContextSlot: bigint, signal: AbortSignal) {
  const sequence = new Uint8Array(8); new DataView(sequence.buffer).setBigUint64(0, fingerprint.sequence, true);
  const [proposal] = await getProgramDerivedAddress({ programAddress: runtime.programAddress,
    seeds: ["resolution_proposal", getAddressEncoder().encode(market), sequence] });
  const response = await rpc.getAccountInfo(proposal, { commitment: "finalized", encoding: "base64", minContextSlot }).send({ abortSignal: signal });
  if (typeof response.context.slot !== "bigint" || response.context.slot < minContextSlot || !response.value
    || response.value.owner !== runtime.programAddress || response.value.executable !== false) throw new Error("Missing finalized pending proposal");
  const bytes = bytesFromRpc(response.value.data, PROPOSAL_ACCOUNT_BYTES), discriminator = await accountDiscriminator("ProposalAccount");
  if (!bytes.subarray(0, 8).every((value, index) => value === discriminator[index])) throw new Error("Invalid proposal discriminator");
  const decoder = getAddressDecoder(), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (decoder.decode(bytes.subarray(8, 40)) !== market || view.getBigUint64(40, true) !== fingerprint.sequence
    || bytes[48] !== 1 || bytes[49] > 2) throw new Error("Pending proposal binding or outcome mismatch");
  const outcome: ResolutionOutcome = bytes[49] === 0 ? "YES" : bytes[49] === 1 ? "NO" : "VOID";
  const reasonDigest = bytes.slice(50, 82), evidenceDigest = bytes.slice(82, 114);
  const proposer = { wallet: decoder.decode(bytes.subarray(114, 146)), enrollment: decoder.decode(bytes.subarray(146, 178)) };
  if (view.getBigInt64(178, true) <= 0n || bytes[186] !== 1 || bytes[187] !== 0
    || bytes.subarray(188, 220).some(Boolean) || bytes[220] !== 0
    || outcome !== fingerprint.outcome
    || !reasonDigest.every((value, index) => value === fingerprint.reasonDigest[index])
    || !evidenceDigest.every((value, index) => value === fingerprint.evidenceDigest[index])) {
    throw new Error("Proposal is not pending with the exact expected fingerprint");
  }
  return { proposal, proposer, proposalSlot: response.context.slot };
}

/** Prepare an independent designated approver's exact-fingerprint decision.
 * The proposal account is re-read finalized at or after the coherent market
 * snapshot so an old UI fingerprint cannot be silently redirected. */
export async function prepareResolutionReview(input: {
  runtime: SolanaRuntime; approver: TransactionSigner; marketId: bigint;
  expected: ResolutionFingerprint; decision: ReviewDecision; signal?: AbortSignal;
}) {
  const runtime = runtimeOf({ ...input.runtime }), approver = input.approver, id = marketId(input.marketId);
  const expected = copyFingerprint(input.expected), decision = input.decision.decision;
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("Invalid resolution review decision");
  const reviewDigest = decision === "REJECT" ? sha256Digest(input.decision.reviewDigestSha256, "Review digest") : null;
  assertIsTransactionSigner(approver); const approverAddress = address(approver.address);
  const signal = input.signal ?? AbortSignal.timeout(15_000); signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const { snapshot, book, terms, resolution } = await readFrozenSnapshot(runtime, approverAddress, id, rpc, signal);
  if (resolution.phase !== 2 || resolution.activeProposalSequence !== expected.sequence
    || resolution.nextProposalSequence !== expected.sequence + 1n) throw new Error("Resolution review phase or proposal sequence is stale");
  if (approverAddress !== resolution.approver.wallet || approverAddress === resolution.proposer.wallet) {
    throw new Error("Only the independent designated approver can review this proposal");
  }
  const pending = await readPendingProposal(rpc, runtime, snapshot.market, expected, snapshot.finalizedSlot, signal);
  if (pending.proposer.wallet !== resolution.proposer.wallet || pending.proposer.enrollment !== resolution.proposer.enrollment) {
    throw new Error("Pending proposal proposer binding mismatch");
  }
  const plan = decision === "APPROVE"
    ? await buildApproveResolutionInstruction({ programAddress: runtime.programAddress, marketId: id,
      seats: snapshot.seats, reviewer: approver, expected })
    : await buildRejectResolutionInstruction({ programAddress: runtime.programAddress, marketId: id,
      seats: snapshot.seats, reviewer: approver, expected, reviewDigest: reviewDigest! });
  if (plan.market !== snapshot.market || plan.config !== snapshot.config || plan.book !== book.book
    || plan.resolution !== resolution.address || plan.proposal !== pending.proposal
    || plan.reviewerEnrollment !== resolution.approver.enrollment) throw new Error("Resolution review bindings changed");
  const signing = await signingLifetime(rpc, runtime, pending.proposalSlot, approver, approverAddress, signal);
  const message = walletMessage(approver, signing.lifetime, plan.instruction);
  const prepared = { message, sender: approverAddress, cluster: runtime.cluster,
    genesisHash: runtime.genesisHash } satisfies PreparedWalletTransaction;
  return { ...prepared, operation: decision === "APPROVE" ? "APPROVE_RESOLUTION" as const : "REJECT_RESOLUTION" as const,
    market: snapshot.market, terms: terms.address, resolution: resolution.address, proposal: pending.proposal,
    seats: snapshot.seats, approverEnrollment: plan.reviewerEnrollment, fingerprint: expected,
    reviewDigestSha256: reviewDigest, expectedPhase: 2 as const, expectedActiveProposalSequence: expected.sequence,
    expectedNextSequence: expected.sequence + 1n, observedSlot: snapshot.finalizedSlot,
    expectedTermsAcceptanceBits: 3 as const, expectedTermsSealed: true as const,
    designatedProposer: resolution.proposer.wallet, designatedApprover: resolution.approver.wallet,
    proposalObservedSlot: pending.proposalSlot, blockhashSlot: signing.blockhashSlot,
    bookRevision: book.revision, lifetime: signing.lifetime };
}
