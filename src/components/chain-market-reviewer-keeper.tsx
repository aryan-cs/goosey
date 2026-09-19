"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  address, compileTransaction, createSolanaRpc, getAddressDecoder, getBase64Decoder, getBase64Encoder,
  type Address, type TransactionMessageBytesBase64,
} from "@solana/kit";
import { RefreshCw } from "lucide-react";
import { readGooseyEscrow } from "@/lib/solana/escrow-read";
import {
  deriveGooseyMarketTermsAddresses, MARKET_TERMS_ACCOUNT_BYTES, readMarketTermsAccount,
} from "@/lib/solana/market-terms-client";
import {
  prepareMarketTermsAcceptance, prepareMarketTermsSeal, prepareResolutionProposal, prepareResolutionReview,
} from "@/lib/solana/prepare-market-review";
import { prepareResolutionClose, prepareResolutionFinalize } from "@/lib/solana/prepare-resolution-keeper";
import { deriveGooseyResolutionAddresses, type ResolutionOutcome } from "@/lib/solana/resolution-client";
import type { SolanaRuntime } from "@/lib/solana/runtime";
import type { PreparedWalletTransaction } from "@/lib/solana/wallet-transaction";
import { SolanaWallet, type WalletAccountProps } from "./solana-wallet";
import { useChainTransaction } from "./use-chain-transaction";
import styles from "./chain-market-reviewer-keeper.module.css";

const U64_MAX = (1n << 64n) - 1n;
const PROPOSAL_ACCOUNT_BYTES = 293n;
const MAX_REVIEW_TEXT_BYTES = 4096;
const MARKET_ID_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const phaseNames = ["Open", "Closed", "Pending review", "Resolved", "Finalized"] as const;

type BaseSnapshot = Awaited<ReturnType<typeof readGooseyEscrow>>;
type Terms = NonNullable<BaseSnapshot["marketTerms"]>;
type Resolution = NonNullable<BaseSnapshot["resolution"]>;
type Book = NonNullable<BaseSnapshot["orderBook"]>;

export type ReviewerKeeperView = Readonly<{
  snapshot: BaseSnapshot & { orderBook: Book };
  terms: Terms;
  resolution: Resolution | null;
  digestHex: string;
  termsSlot: bigint;
  observedSlot: bigint;
}>;

export type ReviewerKeeperAction = "accept_terms" | "seal_terms" | "close" | "propose"
  | "approve" | "reject" | "finalize";

type PreparedAction = Awaited<ReturnType<typeof prepareMarketTermsAcceptance>>
  | Awaited<ReturnType<typeof prepareMarketTermsSeal>>
  | Awaited<ReturnType<typeof prepareResolutionProposal>>
  | Awaited<ReturnType<typeof prepareResolutionReview>>
  | Awaited<ReturnType<typeof prepareResolutionClose>>
  | Awaited<ReturnType<typeof prepareResolutionFinalize>>;

type Material = Readonly<{ label: string; text: string; byteLength: number; digestHex: string }>;
type Review = Readonly<{
  action: ReviewerKeeperAction;
  prepared: PreparedAction;
  fee: bigint;
  rent: bigint;
  facts: readonly (readonly [string, string])[];
  materials: readonly Material[];
}>;

const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
function bytesFromHex(value: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid verified terms digest");
  return Uint8Array.from(value.match(/../g)!, pair => Number.parseInt(pair, 16));
}
function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "The reviewer transaction could not be completed.";
}
function canonicalMarketId(value: string) {
  return MARKET_ID_PATTERN.test(value) && BigInt(value) <= U64_MAX;
}
function lamports(value: bigint) {
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${(value / 1_000_000_000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""}`;
}

/** Hashes the exact UTF-8 entered by a reviewer. No trimming, Unicode
 * normalization, URL fetching, or other hidden transformation is performed. */
export async function hashExplicitReviewText(label: string, value: string) {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const bytes = new TextEncoder().encode(value);
  if (value.trim().length === 0 || bytes.length === 0) throw new Error(`${label} is required.`);
  if (bytes.length > MAX_REVIEW_TEXT_BYTES) throw new Error(`${label} must be at most ${MAX_REVIEW_TEXT_BYTES} UTF-8 bytes.`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (!digest.some(Boolean)) throw new Error(`${label} digest is invalid.`);
  return { label, text: value, byteLength: bytes.length, digest, digestHex: hex(digest) };
}

function decodeAccountBytes(data: unknown) {
  if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== "string" || data[1] !== "base64") {
    throw new Error("Invalid finalized terms account encoding");
  }
  const bytes = new Uint8Array(getBase64Encoder().encode(data[0]));
  if (bytes.length !== MARKET_TERMS_ACCOUNT_BYTES || getBase64Decoder().decode(bytes) !== data[0]) {
    throw new Error("Invalid finalized terms account size or base64");
  }
  return bytes;
}

/** Read the lifecycle without assuming the resolution account already exists.
 * Terms acceptance and sealing necessarily precede resolution initialization. */
export async function loadReviewerKeeperView(runtime: SolanaRuntime, marketId: bigint, wallet: Address,
  suppliedSignal?: AbortSignal): Promise<ReviewerKeeperView> {
  if (typeof marketId !== "bigint" || marketId < 0n || marketId > U64_MAX) throw new Error("Invalid reviewer market ID");
  const selected = address(wallet);
  const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  signal.throwIfAborted();
  const rpc = createSolanaRpc(runtime.rpcUrl);
  const base = await readGooseyEscrow(runtime, { marketId, wallet: selected }, { rpc, signal, includeOrderBook: true });
  if (!base.orderBook || !base.orderBook.reservesReconciled) throw new Error("Missing verified reviewer order book");
  const derivedTerms = await deriveGooseyMarketTermsAddresses({ programAddress: runtime.programAddress, marketId });
  if (derivedTerms.config !== base.config || derivedTerms.market !== base.market || derivedTerms.book !== base.orderBook.book) {
    throw new Error("Reviewer market derivation mismatch");
  }
  const termsResponse = await rpc.getAccountInfo(derivedTerms.terms, { commitment: "finalized", encoding: "base64",
    minContextSlot: base.finalizedSlot }).send({ abortSignal: signal });
  if (typeof termsResponse.context.slot !== "bigint" || termsResponse.context.slot < base.finalizedSlot || !termsResponse.value
    || termsResponse.value.owner !== runtime.programAddress || termsResponse.value.executable !== false) {
    throw new Error("Missing finalized market terms");
  }
  const bytes = decodeAccountBytes(termsResponse.value.data);
  const decoder = getAddressDecoder();
  const proposer = { wallet: decoder.decode(bytes.subarray(109, 141)), enrollment: decoder.decode(bytes.subarray(141, 173)) };
  const approver = { wallet: decoder.decode(bytes.subarray(173, 205)), enrollment: decoder.decode(bytes.subarray(205, 237)) };
  const terms = await readMarketTermsAccount({ programAddress: runtime.programAddress, marketId, config: base.config,
    market: base.market, creator: base.marketState.creator, proposer, approver }, {
    address: derivedTerms.terms, owner: termsResponse.value.owner, executable: termsResponse.value.executable, data: bytes,
  });
  const resolutionAddress = (await deriveGooseyResolutionAddresses({ programAddress: runtime.programAddress, marketId })).resolution;
  const resolutionProbe = await rpc.getAccountInfo(resolutionAddress, { commitment: "finalized", encoding: "base64",
    minContextSlot: termsResponse.context.slot }).send({ abortSignal: signal });
  if (typeof resolutionProbe.context.slot !== "bigint" || resolutionProbe.context.slot < termsResponse.context.slot) {
    throw new Error("Invalid finalized resolution probe");
  }
  signal.throwIfAborted();
  if (resolutionProbe.value !== null) {
    if (!terms.sealed || terms.acceptanceBits !== 3) {
      throw new Error("Resolution account exists before immutable terms were fully accepted and sealed");
    }
    const complete = await readGooseyEscrow(runtime, { marketId, wallet: selected }, {
      rpc, signal, includeOrderBook: true, includeResolution: true, includeMarketTerms: true,
    });
    if (!complete.orderBook?.reservesReconciled || !complete.marketTerms || !complete.resolution
      || complete.marketTerms.address !== terms.address || complete.marketTerms.digest.length !== terms.digest.length
      || !equalBytes(complete.marketTerms.digest, terms.digest) || complete.finalizedSlot < resolutionProbe.context.slot) {
      throw new Error("Incomplete or changed finalized reviewer snapshot");
    }
    return { snapshot: complete as BaseSnapshot & { orderBook: Book }, terms: complete.marketTerms,
      resolution: complete.resolution, digestHex: hex(complete.marketTerms.digest), termsSlot: complete.finalizedSlot,
      observedSlot: complete.finalizedSlot };
  }
  if (await rpc.getGenesisHash().send({ abortSignal: signal }) !== runtime.genesisHash) {
    throw new Error("RPC genesis changed while reading reviewer state");
  }
  signal.throwIfAborted();
  return { snapshot: base as BaseSnapshot & { orderBook: Book }, terms, resolution: null,
    digestHex: hex(terms.digest), termsSlot: termsResponse.context.slot, observedSlot: resolutionProbe.context.slot };
}

export function availableReviewerKeeperActions(view: ReviewerKeeperView, wallet: string): readonly ReviewerKeeperAction[] {
  const actions: ReviewerKeeperAction[] = [];
  const terms = view.terms;
  if (!terms.sealed) {
    if (wallet === terms.proposer.wallet && !(terms.acceptanceBits & 1)) actions.push("accept_terms");
    if (wallet === terms.approver.wallet && !(terms.acceptanceBits & 2)) actions.push("accept_terms");
    if (wallet === terms.creator && terms.acceptanceBits === 3) actions.push("seal_terms");
    return actions;
  }
  const resolution = view.resolution;
  if (!resolution) return actions;
  const book = view.snapshot.orderBook;
  const reservesClear = book.orders.length === 0 && book.seatReserves.every(row => row.reservedCash === 0n
    && row.reservedYes === 0n && row.reservedNo === 0n);
  const totalYes = book.seatReserves.reduce((sum, row) => sum + row.yes, 0n);
  const totalNo = book.seatReserves.reduce((sum, row) => sum + row.no, 0n);
  const closeReady = reservesClear && totalYes === totalNo
    && totalYes * view.snapshot.marketState.payoutMilli === view.snapshot.marketState.collateral;
  const finalizeReady = reservesClear && book.seatReserves.every(row => row.yes === 0n && row.no === 0n)
    && resolution.outstandingYes === 0n && resolution.outstandingNo === 0n
    && (resolution.outcome === 2 || view.snapshot.marketState.collateral === 0n);
  if (resolution.phase === 0 && closeReady) actions.push("close");
  if (resolution.phase === 1 && wallet === resolution.proposer.wallet) actions.push("propose");
  if (resolution.phase === 2 && wallet === resolution.approver.wallet
    && wallet !== resolution.proposer.wallet) actions.push("approve", "reject");
  if (resolution.phase === 3 && finalizeReady) actions.push("finalize");
  return actions;
}

function assertPristine(view: ReviewerKeeperView) {
  const { snapshot } = view, book = snapshot.orderBook;
  if (book.revision !== 0n || book.nextSequence !== 1n || book.orders.length !== 0
    || snapshot.marketState.collateral !== 0n || snapshot.marketState.feeRevenue !== 0n
    || book.seatReserves.some(seat => seat.yes !== 0n || seat.no !== 0n || seat.reservedCash !== 0n
      || seat.reservedYes !== 0n || seat.reservedNo !== 0n || seat.everTraded)) {
    throw new Error("Market is no longer pristine for terms review.");
  }
}

/** Finalized recheck immediately before handing the already-reviewed message to
 * the wallet flow. This never replaces the reviewed message or blockhash. */
export function assertReviewerKeeperRecheck(review: Pick<Review, "prepared">, view: ReviewerKeeperView, wallet: string) {
  const prepared = review.prepared;
  if (prepared.sender !== wallet || prepared.market !== view.snapshot.market || prepared.terms !== view.terms.address) {
    throw new Error("Reviewer identity or market binding changed. Prepare again.");
  }
  const financialSlot = "financialObservedSlot" in prepared ? prepared.financialObservedSlot : prepared.observedSlot;
  if (view.snapshot.finalizedSlot < financialSlot || view.termsSlot < prepared.observedSlot
    || view.observedSlot < prepared.observedSlot) {
    throw new Error("Finalized reviewer state moved behind the prepared review.");
  }
  const expectedBookRevision = "bookRevision" in prepared ? prepared.bookRevision : prepared.expectedBookRevision;
  if (view.snapshot.orderBook.revision !== expectedBookRevision) throw new Error("Order book changed. Prepare again.");
  if (prepared.operation === "ACCEPT_TERMS" || prepared.operation === "SEAL_TERMS") {
    if (view.digestHex !== hex(prepared.expectedDigestSha256) || view.terms.sealed
      || view.terms.acceptanceBits !== prepared.expectedAcceptanceBits) throw new Error("Terms changed. Prepare again.");
    assertPristine(view);
    if (prepared.operation === "ACCEPT_TERMS") {
      const bit = prepared.role === "proposer" ? 1 : 2;
      if (view.terms[prepared.role].wallet !== wallet || view.terms.acceptanceBits & bit) {
        throw new Error("Terms reviewer role changed. Prepare again.");
      }
    } else if (view.terms.creator !== wallet || view.terms.acceptanceBits !== 3) {
      throw new Error("Terms sealing authority changed. Prepare again.");
    }
    return true;
  }
  const resolution = view.resolution;
  if (!resolution || prepared.resolution !== resolution.address || !view.terms.sealed || view.terms.acceptanceBits !== 3) {
    throw new Error("Resolution binding or sealed terms changed. Prepare again.");
  }
  if (prepared.operation === "PROPOSE_RESOLUTION") {
    if (resolution.phase !== 1 || resolution.activeProposalSequence !== null
      || resolution.nextProposalSequence !== prepared.expectedNextSequence || resolution.proposer.wallet !== wallet) {
      throw new Error("Resolution proposal state changed. Prepare again.");
    }
  } else if (prepared.operation === "APPROVE_RESOLUTION" || prepared.operation === "REJECT_RESOLUTION") {
    if (resolution.phase !== 2 || resolution.activeProposalSequence !== prepared.expectedActiveProposalSequence
      || resolution.nextProposalSequence !== prepared.expectedNextSequence || resolution.approver.wallet !== wallet
      || resolution.proposer.wallet === wallet) throw new Error("Resolution review state changed. Prepare again.");
  } else if (prepared.operation === "CLOSE_RESOLUTION") {
    if (resolution.phase !== 0 || resolution.activeProposalSequence !== null || resolution.outcome !== null) {
      throw new Error("Resolution close state changed. Prepare again.");
    }
  } else if (prepared.operation === "FINALIZE_RESOLUTION") {
    const book = view.snapshot.orderBook;
    const positionsRemain = book.seatReserves.some(row => row.yes !== 0n || row.no !== 0n
      || row.reservedCash !== 0n || row.reservedYes !== 0n || row.reservedNo !== 0n);
    if (resolution.phase !== 3 || resolution.activeProposalSequence !== null || resolution.outcome === null
      || resolution.outstandingYes !== 0n || resolution.outstandingNo !== 0n || book.orders.length !== 0
      || positionsRemain || (resolution.outcome !== 2 && view.snapshot.marketState.collateral !== 0n)) {
      throw new Error("Resolution finalization state changed. Prepare again.");
    }
  }
  return true;
}

function reviewFacts(prepared: PreparedAction, marketId: bigint, fee: bigint, rent: bigint) {
  const values: [string, string][] = [
    ["Operation", prepared.operation], ["Market ID", marketId.toString()], ["Wallet / fee payer", prepared.sender],
    ["Network", prepared.cluster], ["Market account", prepared.market], ["Terms account", prepared.terms],
  ];
  if ("resolution" in prepared) values.push(["Resolution account", prepared.resolution]);
  if ("proposal" in prepared) values.push(["Proposal account", prepared.proposal]);
  if ("bookRevision" in prepared) values.push(["Expected book revision", prepared.bookRevision.toString()]);
  if ("expectedBookRevision" in prepared) values.push(["Expected book revision", prepared.expectedBookRevision.toString()]);
  if ("financialObservedSlot" in prepared) values.push(["Financial snapshot slot", prepared.financialObservedSlot.toString()]);
  values.push(["Observed finalized slot", prepared.observedSlot.toString()], ["Blockhash context slot", prepared.blockhashSlot.toString()]);
  if ("proposalObservedSlot" in prepared) values.push(["Proposal fingerprint slot", prepared.proposalObservedSlot.toString()]);
  if ("expectedPhase" in prepared) values.push(["Expected phase", phaseNames[prepared.expectedPhase]]);
  if ("expectedNextPhase" in prepared) values.push(["Expected transition", `${phaseNames[prepared.expectedPhase]} → ${phaseNames[prepared.expectedNextPhase]}`]);
  if ("fingerprint" in prepared) {
    values.push(["Proposal sequence", prepared.fingerprint.sequence.toString()], ["Outcome", prepared.fingerprint.outcome],
      ["Reason SHA-256", hex(prepared.fingerprint.reasonDigest)], ["Evidence SHA-256", hex(prepared.fingerprint.evidenceDigest)]);
  }
  if ("reviewDigestSha256" in prepared && prepared.reviewDigestSha256) values.push(["Review reason SHA-256", hex(prepared.reviewDigestSha256)]);
  values.push(["Network fee estimate", `${lamports(fee)} SOL`], ["Account deposit estimate", `${lamports(rent)} SOL`],
    ["Last valid block height", prepared.lifetime.lastValidBlockHeight.toString()]);
  return values;
}

export function ChainMarketReviewerKeeper({ marketId }: { marketId: string }) {
  if (!canonicalMarketId(marketId)) return <section className={styles.panel}><h2>Reviewer and keeper</h2>
    <p role="alert">The canonical on-chain market ID is invalid.</p></section>;
  return <SolanaWallet renderAccount={props => <ReviewerKeeperAccount key={`${marketId}:${props.snapshot.account?.address ?? ""}`}
    {...props} marketId={BigInt(marketId)} />} />;
}

function ReviewerKeeperAccount({ runtime, wallet, snapshot, marketId }: WalletAccountProps & { marketId: bigint }) {
  const account = snapshot.account!.address;
  const id = useId();
  const lifetime = useRef<AbortController | null>(null);
  const active = useRef(false);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<ReviewerKeeperView | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [proposalOutcome, setProposalOutcome] = useState<ResolutionOutcome>("YES");
  const [proposalReason, setProposalReason] = useState("");
  const [proposalEvidence, setProposalEvidence] = useState("");
  const [reviewOutcome, setReviewOutcome] = useState<ResolutionOutcome>("YES");
  const [reviewReason, setReviewReason] = useState("");
  const [reviewEvidence, setReviewEvidence] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const refresh = useCallback(() => { setLoading(true); setReload(value => value + 1); }, []);
  const tx = useChainTransaction({ runtime, wallet, snapshot, onFinalized: refresh });
  const disabled = preparing || Boolean(tx.busy) || !tx.ready;

  function unchanged(signal: AbortSignal) {
    signal.throwIfAborted();
    const current = wallet.getSnapshot();
    if (current.generation !== snapshot.generation || current.status !== "connected"
      || current.account?.address !== account) throw new Error("Wallet changed. Prepare this action again.");
  }

  useEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    loadReviewerKeeperView(runtime, marketId, address(account), signal).then(next => {
      if (!controller.signal.aborted) { setView(next); setError(null); }
    }).catch(reason => { if (!controller.signal.aborted) { setView(null); setReview(null); setError(message(reason)); } })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(() => setReload(value => value + 1), 15_000); } });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [runtime, marketId, account, reload]);

  async function prepare(action: ReviewerKeeperAction) {
    if (active.current || disabled || review || !lifetime.current) return;
    active.current = true; setPreparing(true); setError(null);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(45_000)]);
    try {
      const current = await loadReviewerKeeperView(runtime, marketId, address(account), signal);
      unchanged(signal);
      if (!availableReviewerKeeperActions(current, account).includes(action)) throw new Error("This wallet or lifecycle state cannot perform that action.");
      const signer = wallet.getSigner();
      const materials: Material[] = [];
      let prepared: PreparedAction;
      if (action === "accept_terms") prepared = await prepareMarketTermsAcceptance({ runtime, reviewer: signer, marketId,
        expectedDigestSha256: bytesFromHex(current.digestHex), signal });
      else if (action === "seal_terms") prepared = await prepareMarketTermsSeal({ runtime, creator: signer, marketId,
        expectedDigestSha256: bytesFromHex(current.digestHex), signal });
      else if (action === "close") prepared = await prepareResolutionClose({ runtime, keeper: signer, marketId, signal });
      else if (action === "finalize") prepared = await prepareResolutionFinalize({ runtime, keeper: signer, marketId, signal });
      else {
        const reason = await hashExplicitReviewText("Resolution reason", action === "propose" ? proposalReason : reviewReason);
        const evidence = await hashExplicitReviewText("Resolution evidence", action === "propose" ? proposalEvidence : reviewEvidence);
        materials.push(reason, evidence);
        const resolution = current.resolution!;
        if (action === "propose") prepared = await prepareResolutionProposal({ runtime, proposer: signer, marketId,
          expectedNextSequence: resolution.nextProposalSequence, outcome: proposalOutcome,
          reasonDigestSha256: reason.digest, evidenceDigestSha256: evidence.digest, signal });
        else {
          const expected = { sequence: resolution.activeProposalSequence!, outcome: reviewOutcome,
            reasonDigest: reason.digest, evidenceDigest: evidence.digest };
          if (action === "reject") {
            const rationale = await hashExplicitReviewText("Rejection reason", rejectionReason); materials.push(rationale);
            prepared = await prepareResolutionReview({ runtime, approver: signer, marketId, expected,
              decision: { decision: "REJECT", reviewDigestSha256: rationale.digest }, signal });
          } else prepared = await prepareResolutionReview({ runtime, approver: signer, marketId, expected,
            decision: { decision: "APPROVE" }, signal });
        }
      }
      unchanged(signal);
      const rpc = createSolanaRpc(runtime.rpcUrl);
      const encoded = getBase64Decoder().decode(compileTransaction(prepared.message).messageBytes) as TransactionMessageBytesBase64;
      const feeResponse = await rpc.getFeeForMessage(encoded, { commitment: "confirmed" }).send({ abortSignal: signal });
      if (feeResponse.value === null) throw new Error("The transaction expired while preparing its review.");
      const rent = prepared.operation === "PROPOSE_RESOLUTION"
        ? await rpc.getMinimumBalanceForRentExemption(PROPOSAL_ACCOUNT_BYTES, { commitment: "finalized" }).send({ abortSignal: signal }) : 0n;
      const balance = await rpc.getBalance(address(account), { commitment: "finalized" }).send({ abortSignal: signal });
      if (balance.value < feeResponse.value + rent) throw new Error("This wallet needs enough SOL for the network fee and account deposit.");
      unchanged(signal); setView(current);
      setReview({ action, prepared, fee: feeResponse.value, rent,
        facts: reviewFacts(prepared, marketId, feeResponse.value, rent), materials });
    } catch (reason) { if (!lifetime.current.signal.aborted) setError(message(reason)); }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setPreparing(false); }
  }

  async function approve() {
    if (!review || active.current || disabled || !lifetime.current) return;
    const chosen = review; active.current = true; setPreparing(true); setError(null);
    try {
      const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]);
      const current = await loadReviewerKeeperView(runtime, marketId, address(account), signal);
      unchanged(signal); assertReviewerKeeperRecheck(chosen, current, account);
      setView(current); setReview(null); setPreparing(false);
      await tx.submit(chosen.prepared satisfies PreparedWalletTransaction);
    } catch (reason) { if (!lifetime.current.signal.aborted) { setReview(null); setError(message(reason)); } }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setPreparing(false); }
  }

  const actions = view ? availableReviewerKeeperActions(view, account) : [];
  const resolution = view?.resolution;
  const role = !view ? null : account === view.terms.creator ? "Creator"
    : account === view.terms.proposer.wallet ? "Proposer" : account === view.terms.approver.wallet ? "Approver" : "Keeper";

  return <div className={styles.root}>
    <section className={styles.panel}>
      <header className={styles.heading}><div><p className={styles.eyebrow}>Finalized on-chain governance</p><h2>Reviewer and keeper</h2></div>
        <button type="button" className="button button-secondary" disabled={preparing || Boolean(tx.busy)}
          onClick={() => { setReview(null); setError(null); refresh(); }}><RefreshCw aria-hidden="true" /> Refresh</button></header>
      <code className={styles.address}>{account}</code>
      {loading && <p role="status">Reading finalized reviewer and resolution state…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {tx.error && <p className={styles.error} role="alert">{tx.error}</p>}
      {(preparing || tx.busy) && <p role="status">{tx.busy ?? "Preparing a finalized transaction review…"}</p>}
      {view && <div className={styles.metrics}>
        <div><span>Role</span><strong>{role}</strong></div>
        <div><span>Terms</span><strong>{view.terms.sealed ? "Sealed" : `${view.terms.acceptanceBits}/3 accepted`}</strong></div>
        <div><span>Resolution</span><strong>{resolution ? phaseNames[resolution.phase] : "Not initialized"}</strong></div>
        <div><span>Finalized slot</span><strong>{view.observedSlot.toString()}</strong></div>
      </div>}
      {view && <details><summary>Verified bindings and recheck source</summary><dl className={styles.facts}>
        <div><dt>Market</dt><dd>{view.snapshot.market}</dd></div><div><dt>Terms</dt><dd>{view.terms.address}</dd></div>
        <div><dt>Terms SHA-256</dt><dd>{view.digestHex}</dd></div><div><dt>Book revision</dt><dd>{view.snapshot.orderBook.revision.toString()}</dd></div>
        <div><dt>Proposer</dt><dd>{view.terms.proposer.wallet}</dd></div><div><dt>Approver</dt><dd>{view.terms.approver.wallet}</dd></div>
      </dl></details>}
    </section>

    {view && !resolution && view.terms.sealed && <section className={styles.panel}><h2>Resolution initialization pending</h2>
      <p>Terms are sealed, but the finalized resolution account does not exist yet. This surface will not invent reviewer state or enable resolution actions.</p></section>}

    {view && actions.some(action => action === "accept_terms" || action === "seal_terms") && <section className={styles.panel}>
      <h2>Immutable market terms</h2><p>Review the committed digest and verified bindings above. Acceptance and sealing cannot change the manifest.</p>
      <div className={styles.actions}>
        {actions.includes("accept_terms") && <button type="button" className="button button-primary" disabled={disabled || Boolean(review)} onClick={() => void prepare("accept_terms")}>Review terms acceptance</button>}
        {actions.includes("seal_terms") && <button type="button" className="button button-primary" disabled={disabled || Boolean(review)} onClick={() => void prepare("seal_terms")}>Review terms seal</button>}
      </div>
    </section>}

    {view && resolution?.phase === 1 && account === resolution.proposer.wallet && <section className={styles.panel}>
      <h2>Propose resolution</h2><p>Sequence {resolution.nextProposalSequence.toString()}. The exact UTF-8 reason and evidence are hashed locally; only their SHA-256 digests enter the transaction.</p>
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void prepare("propose"); }}>
        <label htmlFor={`${id}-proposal-outcome`}>Outcome</label><select id={`${id}-proposal-outcome`} value={proposalOutcome} disabled={disabled || Boolean(review)} onChange={event => setProposalOutcome(event.target.value as ResolutionOutcome)}><option>YES</option><option>NO</option><option>VOID</option></select>
        <label htmlFor={`${id}-proposal-reason`}>Resolution reason</label><textarea id={`${id}-proposal-reason`} value={proposalReason} disabled={disabled || Boolean(review)} onChange={event => setProposalReason(event.target.value)} required rows={5} />
        <label htmlFor={`${id}-proposal-evidence`}>Resolution evidence</label><textarea id={`${id}-proposal-evidence`} value={proposalEvidence} disabled={disabled || Boolean(review)} onChange={event => setProposalEvidence(event.target.value)} required rows={7} placeholder="Cite the exact source material and observations used." />
        <p className={styles.note}>Whitespace and Unicode are hashed exactly as entered. Each field is limited to {MAX_REVIEW_TEXT_BYTES} UTF-8 bytes.</p>
        <button className="button button-primary" disabled={disabled || Boolean(review)}>Review resolution proposal</button>
      </form>
    </section>}

    {view && resolution?.phase === 2 && account === resolution.approver.wallet && <section className={styles.panel}>
      <h2>Independently review proposal</h2><p>Re-enter the proposal’s exact outcome, reason, and evidence. Preparation succeeds only if all three hashes match finalized proposal sequence {resolution.activeProposalSequence?.toString()}.</p>
      <div className={styles.form}>
        <label htmlFor={`${id}-review-outcome`}>Expected outcome</label><select id={`${id}-review-outcome`} value={reviewOutcome} disabled={disabled || Boolean(review)} onChange={event => setReviewOutcome(event.target.value as ResolutionOutcome)}><option>YES</option><option>NO</option><option>VOID</option></select>
        <label htmlFor={`${id}-review-reason`}>Exact proposal reason</label><textarea id={`${id}-review-reason`} value={reviewReason} disabled={disabled || Boolean(review)} onChange={event => setReviewReason(event.target.value)} required rows={5} />
        <label htmlFor={`${id}-review-evidence`}>Exact proposal evidence</label><textarea id={`${id}-review-evidence`} value={reviewEvidence} disabled={disabled || Boolean(review)} onChange={event => setReviewEvidence(event.target.value)} required rows={7} />
        <label htmlFor={`${id}-rejection-reason`}>Rejection reason <span>(required only when rejecting)</span></label><textarea id={`${id}-rejection-reason`} value={rejectionReason} disabled={disabled || Boolean(review)} onChange={event => setRejectionReason(event.target.value)} rows={4} />
        <p className={styles.note}>Approval binds the exact proposal fingerprint. Rejection additionally commits the SHA-256 digest of its reason.</p>
        <div className={styles.actions}><button type="button" className="button button-primary" disabled={disabled || Boolean(review) || !reviewReason || !reviewEvidence} onClick={() => void prepare("approve")}>Review approval</button>
          <button type="button" className="button button-secondary" disabled={disabled || Boolean(review) || !reviewReason || !reviewEvidence || !rejectionReason} onClick={() => void prepare("reject")}>Review rejection</button></div>
      </div>
    </section>}

    {view && actions.some(action => action === "close" || action === "finalize") && <section className={styles.panel}>
      <h2>Permissionless keeper</h2><p>Keeper preparation rechecks finalized chain time, order-book reserves, positions, collateral, claims, reviewer bindings, and the exact lifecycle phase.</p>
      <div className={styles.actions}>{actions.includes("close") && <button type="button" className="button button-secondary" disabled={disabled || Boolean(review)} onClick={() => void prepare("close")}>Review market close</button>}
        {actions.includes("finalize") && <button type="button" className="button button-secondary" disabled={disabled || Boolean(review)} onClick={() => void prepare("finalize")}>Review finalization</button>}</div>
    </section>}

    {view && actions.length === 0 && !(view.terms.sealed && !resolution) && <section className={styles.panel}><h2>No available action</h2>
      <p>This wallet has no reviewer action in the current finalized state. Permissionless keeper actions appear only in Open or fully claimed Resolved phases.</p></section>}

    {review && <section className={`${styles.panel} ${styles.review}`} aria-labelledby={`${id}-transaction-review`}>
      <h2 id={`${id}-transaction-review`} ref={reviewHeading} tabIndex={-1}>Review {review.prepared.operation.toLowerCase().replaceAll("_", " ")}</h2>
      <p>The values below will be re-read from finalized state immediately before this exact message is handed to the wallet.</p>
      <dl className={styles.facts}>{review.facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {review.materials.map(material => <details key={material.label} open><summary>{material.label} · {material.byteLength} UTF-8 bytes</summary>
        <p><strong>SHA-256</strong> <code>{material.digestHex}</code></p><pre>{material.text}</pre></details>)}
      <p className={styles.note}>Wallet approval signs only this prepared transaction. A changed role, phase, sequence, digest, book revision, account binding, or wallet cancels the review.</p>
      <div className={styles.actions}><button type="button" className="button button-secondary" disabled={preparing || Boolean(tx.busy)} onClick={() => setReview(null)}>Cancel review</button>
        <button type="button" className="button button-primary" disabled={disabled} onClick={() => void approve()}>Recheck and approve in wallet</button></div>
    </section>}

    {tx.receipts.length > 0 && <section className={styles.panel}><h2>Saved transactions</h2><p>Recovery checks status and never resends a transaction.</p>
      <ul className={styles.receipts}>{tx.receipts.map(receipt => <li key={receipt.signature}><strong>{receipt.status === "expired" ? "Expired · historical outcome unknown" : receipt.status}</strong><code>{receipt.signature}</code></li>)}</ul>
      <button type="button" className="button button-secondary" disabled={Boolean(tx.busy) || preparing} onClick={() => { setReview(null); void tx.recover(); }}>Check transaction status</button></section>}
  </div>;
}
