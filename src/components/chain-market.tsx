"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { address, compileTransaction, createSolanaRpc, getBase64Decoder, type TransactionMessageBytesBase64 } from "@solana/kit";
import { ChevronDown } from "lucide-react";
import { SolanaWallet, type WalletAccountProps } from "./solana-wallet";
import { useChainTransaction } from "./use-chain-transaction";
import { loadChainMarket } from "@/lib/solana/market-view";
import { prepareOrder } from "@/lib/solana/prepare-order";
import { MarketResolutionNote } from "./market-resolution-note";
import { prepareCancelOrder } from "@/lib/solana/prepare-cancel";
import { prepareEscrowDeposit, prepareEscrowWithdrawal } from "@/lib/solana/prepare-escrow";
import { prepareResolutionClaim } from "@/lib/solana/prepare-resolution-claim";
import { prepareMarketSeat } from "@/lib/solana/prepare-seat";
import { parseFeatherAmount } from "@/lib/solana/feather-transfer";
import type { PreparedWalletTransaction } from "@/lib/solana/wallet-transaction";
import type { CanonicalBookOrder } from "@/lib/solana/order-book-read";
import shared from "./solana-wallet.module.css";
import styles from "./chain-market.module.css";

type View = Awaited<ReturnType<typeof loadChainMarket>>;
type Intent = { kind: "order"; action: "BUY" | "SELL"; outcome: "YES" | "NO"; price: bigint; quantity: bigint; timeInForce: "GTC" | "IOC" | "FOK" }
  | { kind: "deposit" | "withdrawal"; amount: bigint } | { kind: "cancel"; orderId: bigint } | { kind: "claim" | "register" };
type Review = { intent: Intent; transaction: PreparedWalletTransaction; digest: string; expectedNonce?: bigint; fee: bigint; rent: bigint; facts: [string,string][] };
const describe = (error: unknown) => error instanceof Error ? error.message : "The chain request could not be completed.";
function feathers(value: bigint) { const fraction = (value % 1000n).toString().padStart(3,"0").replace(/0+$/,""); return `${(value / 1000n).toLocaleString("en-CA")}${fraction ? `.${fraction}` : ""}`; }
const phaseNames = ["Open", "Closed", "Under review", "Resolved", "Finalized"];
const date = (seconds: bigint) => new Date(Number(seconds) * 1000).toLocaleString();

export function ChainMarket({ marketId }: { marketId: string }) {
  const [title, setTitle] = useState(`On-chain market ${marketId}`);
  return <div className={styles.page}><header className={styles.header}><Link href="/markets" className="section-link">Markets</Link><h1>{title}</h1></header><SolanaWallet renderAccount={props => <MarketAccount key={marketId} {...props} marketId={BigInt(marketId)} onTitle={setTitle} />} /></div>;
}

function MarketAccount({ runtime, wallet, snapshot, marketId, onTitle }: WalletAccountProps & { marketId: bigint; onTitle: (title: string) => void }) {
  const account = snapshot.account!.address;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<"BUY"|"SELL">("BUY");
  const [outcome, setOutcome] = useState<"YES"|"NO">("YES");
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [timeInForce, setTimeInForce] = useState<"GTC"|"IOC"|"FOK">("GTC");
  const [cash, setCash] = useState("");
  const id = useId(), active = useRef(false), lifetime = useRef<AbortController | null>(null), reviewHeading = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(() => { setReload(value => value + 1); }, []);
  const tx = useChainTransaction({ runtime, wallet, snapshot, onFinalized: refresh });
  const disabled = preparing || Boolean(tx.busy) || !tx.ready;
  useEffect(() => { const c = new AbortController(); lifetime.current = c; return () => c.abort(); }, []);
  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try { const next = await loadChainMarket(runtime, marketId, address(account), AbortSignal.any([c.signal, AbortSignal.timeout(30_000)])); if (!c.signal.aborted) { setView(next); onTitle(next.terms.question); setLoadError(null); } }
      catch(reason) { if (!c.signal.aborted) { setView(null); setReview(null); setLoadError(describe(reason)); } }
      finally { if (!c.signal.aborted) timer = setTimeout(read, 15_000); }
    }
    void read(); return () => { c.abort(); clearTimeout(timer); };
  }, [runtime, marketId, account, reload, onTitle]);
  function unchanged(signal: AbortSignal) {
    signal.throwIfAborted(); const current = wallet.getSnapshot();
    if (current.generation !== snapshot.generation || current.status !== "connected" || current.account?.address !== account) throw new Error("Wallet changed. Prepare this action again.");
  }
  async function prepare(intent: Intent) {
    if (active.current || disabled || !lifetime.current) return;
    active.current = true; setPreparing(true); setError(null); setReview(null);
    const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(45_000)]);
    try {
      const latest = await loadChainMarket(runtime, marketId, address(account), signal); unchanged(signal);
      const sender = wallet.getSigner(), base = { runtime, sender, marketId, signal };
      let transaction: PreparedWalletTransaction;
      const facts: [string,string][] = [["Action", intent.kind], ["Market", latest.terms.question], ["Market ID", marketId.toString()], ["Wallet", account], ["Mint", latest.snapshot.featherMint], ["Network", runtime.cluster]];
      if (intent.kind === "order") {
        const preparedOrder = await prepareOrder({ ...base, ...intent, selfTrade: "CANCEL_AGGRESSOR", touches: 16 });
        transaction = preparedOrder;
        facts.push(["Order", `${intent.action} ${intent.quantity} ${intent.outcome}`], ["Limit price", `${feathers(intent.price)} feathers / contract`], ["Time in force", intent.timeInForce], ["Limit notional", `${feathers(intent.price * intent.quantity)} feathers`], ["Trading fee", `${latest.snapshot.marketState.feeBps / 100}%`]);
        if (intent.action === "BUY") facts.push(["Maximum cash reserve", `${feathers(preparedOrder.requiredCash)} feathers`]);
      } else if (intent.kind === "cancel") { transaction = await prepareCancelOrder({ ...base, orderId: intent.orderId }); facts.push(["Order ID", intent.orderId.toString()]); }
      else if (intent.kind === "deposit" || intent.kind === "withdrawal") { transaction = await (intent.kind === "deposit" ? prepareEscrowDeposit : prepareEscrowWithdrawal)({ ...base, amount: intent.amount }); facts.push(["Amount", `${feathers(intent.amount)} feathers`]); }
      else if (intent.kind === "register") { transaction = await prepareMarketSeat(base); facts.push(["Registration", "Permanent market seat"]); }
      else {
        transaction = await prepareResolutionClaim({ runtime, payer: sender, targetWallet: address(account), marketId, signal });
        const position = latest.snapshot.seat, result = latest.snapshot.resolution.outcome;
        if (!position || result === null) throw new Error("No resolved position is available.");
        const payout = latest.snapshot.marketState.payoutMilli;
        const credit = result === 0 ? position.yes * payout : result === 1 ? position.no * payout : ((position.yes + position.no) * payout) / 2n;
        facts.push(["Outcome", ["YES", "NO", "VOID"][result]], ["Positions settled", `${position.yes} YES · ${position.no} NO`], ["Expected escrow credit", `${feathers(credit)} feathers`], ["Proceeds", "Credit this market’s escrow; withdraw separately"]);
      }
      const rpc = createSolanaRpc(runtime.rpcUrl);
      const encoded = getBase64Decoder().decode(compileTransaction(transaction.message).messageBytes) as TransactionMessageBytesBase64;
      const fee = await rpc.getFeeForMessage(encoded, { commitment: "confirmed" }).send({ abortSignal: signal });
      if (fee.value === null) throw new Error("Transaction expired. Prepare again.");
      // Exact shipping Borsh account sizes including Anchor discriminator:
      // SeatLocator = 8 + 32 + 32 + 4 + 1; ClaimReceipt = 8 + 101.
      const accountBytes = intent.kind === "register" ? 77n : intent.kind === "claim" ? 109n : 0n;
      const rent = accountBytes ? await rpc.getMinimumBalanceForRentExemption(accountBytes, { commitment: "finalized" }).send({ abortSignal: signal }) : 0n;
      const sol = await rpc.getBalance(address(account), { commitment: "finalized" }).send({ abortSignal: signal });
      if (sol.value < fee.value + rent) throw new Error("This wallet needs more SOL for the network fee and account deposit.");
      unchanged(signal); setView(latest); setReview({ intent, transaction, digest: latest.digest, expectedNonce: "expectedNonce" in transaction && typeof transaction.expectedNonce === "bigint" ? transaction.expectedNonce : undefined, fee: fee.value, rent, facts });
    } catch(reason) { if (!lifetime.current.signal.aborted) setError(describe(reason)); }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setPreparing(false); }
  }
  async function approve() {
    if (!review || disabled || active.current || !lifetime.current) return;
    const chosen = review; active.current = true; setPreparing(true); setError(null);
    try {
      const signal = AbortSignal.any([lifetime.current.signal, AbortSignal.timeout(30_000)]);
      const latest = await loadChainMarket(runtime, marketId, address(account), signal); unchanged(signal);
      if (latest.digest !== chosen.digest) throw new Error("Market terms changed. Review again before signing.");
      if (chosen.expectedNonce !== undefined && latest.snapshot.seat?.nextNonce !== chosen.expectedNonce) throw new Error("Your market account changed. Prepare a fresh review before signing.");
      if (chosen.intent.kind === "register" && latest.snapshot.registered) throw new Error("This wallet already has a market seat.");
      setReview(null); setPreparing(false);
      await tx.submit(chosen.transaction);
      if (!lifetime.current.signal.aborted) refresh();
    } catch(reason) { if (!lifetime.current.signal.aborted) { setReview(null); setError(describe(reason)); } }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setPreparing(false); }
  }
  function order() {
    try { if (!/^[1-9][0-9]*$/.test(quantity) || BigInt(quantity) > 10_000_000n) throw new Error("Enter 1–10,000,000 whole contracts."); void prepare({ kind: "order", action, outcome, price: parseFeatherAmount(price), quantity: BigInt(quantity), timeInForce }); }
    catch(reason) { setError(describe(reason)); }
  }
  function escrow(kind: "deposit"|"withdrawal") { try { void prepare({kind, amount: parseFeatherAmount(cash)}); } catch(reason) { setError(describe(reason)); } }
  const data = view?.snapshot, seat = data?.seat, terms = view?.terms;
  const own = data?.orderBook.orders.filter(item => item.wallet === account) ?? [];
  const reviewer = data?.marketTerms.proposer.wallet === account || data?.marketTerms.approver.wallet === account;
  return <div className={styles.column}>
    {(error || loadError || tx.error) && <section className={shared.panel}><p className={shared.error} role="alert">{error ?? loadError ?? tx.error}</p><button className="button button-secondary" onClick={() => { setError(null); refresh(); void tx.recover(); }} disabled={Boolean(tx.busy)}>Try again</button></section>}
    {(preparing || tx.busy) && <p role="status">{tx.busy ?? "Preparing transaction…"}</p>}
    {!view && !loadError && <p role="status">Verifying finalized market data and committed terms…</p>}
    {data && terms && <>
      <header className={styles.header}><p>{phaseNames[data.resolution.phase]} · Closes {date(data.marketState.closesAt)} · {feathers(data.marketState.payoutMilli)} feathers per winning contract</p></header>
      <div className={styles.layout}>
        <div className={styles.column}>
          <section className={shared.panel}><h2>Order book</h2><p>Resting orders · YES-equivalent prices · finalized slot {data.finalizedSlot.toString()}</p><Book orders={data.orderBook.bids} label="Bids" /><Book orders={data.orderBook.asks} label="Asks" /></section>
          <section className={shared.panel}><h2>Your positions</h2>{seat ? <div className={styles.metrics}>{[["Available feathers",feathers(seat.availableCash)],["Reserved feathers",feathers(seat.reservedCash)],["YES contracts",seat.yes.toString()],["NO contracts",seat.no.toString()],["Reserved YES",seat.reservedYes.toString()],["Reserved NO",seat.reservedNo.toString()]].map(([label,value])=><div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div> : <p>No market seat registered for this wallet.</p>}
            {data.resolution.outcome !== null && <p>Outcome: {["YES","NO","VOID"][data.resolution.outcome]}</p>}
            {seat && (seat.yes > 0n || seat.no > 0n) && data.resolution.phase === 3 && <button className="button button-primary" disabled={disabled || Boolean(review)} onClick={()=>void prepare({kind:"claim"})}>Review resolution claim</button>}
          </section>
          <section className={shared.panel}><h2>Your open orders</h2>{own.length ? <ul className={styles.orders}>{own.map(item=><li key={item.id.toString()}><div><strong>{item.action === "BUY" ? "Buy" : "Sell"} {item.remaining.toString()} {item.outcome}</strong><small>{feathers(item.limitPrice)} feathers · Order {item.id.toString()}{item.expiresAt ? ` · Expires ${date(item.expiresAt)}` : ""}</small></div><button className="button button-secondary" disabled={disabled || Boolean(review)} onClick={()=>void prepare({kind:"cancel",orderId:item.id})}>Cancel</button></li>)}</ul> : <p>No resting orders.</p>}</section>
          <section className={`${shared.panel} ${styles.rules}`}><h2>Market rules</h2>{(["yes","no","void"] as const).map(key=><div key={key}><h3>{key.toUpperCase()}</h3><p>{terms.rules[key]}</p></div>)}<MarketResolutionNote /><h3>Sources</h3>{terms.sources.map(source=><div key={source.id}><a href={source.uri} target="_blank" rel="noreferrer">{source.id}</a><p>{source.selection}</p></div>)}<details><summary>Source policy and verified terms</summary><p>{terms.sourcePolicy.missing}</p><p>{terms.sourcePolicy.revisions}</p><p>Observation: {date(BigInt(terms.observation.startsAt))} – {date(BigInt(terms.observation.endsAt))}</p><code className={shared.address}>{view.digest}</code></details></section>
        </div>
        <div className={styles.column}>
          <section className={shared.panel}><h2>Trade</h2>{!seat ? <><p>Register this wallet’s market seat before depositing collateral or trading.</p><button className="button button-primary" disabled={disabled || Boolean(review)} onClick={()=>void prepare({kind:"register"})}>Review registration</button></> : <form className={shared.form} onSubmit={event=>{event.preventDefault();order();}}>
            <fieldset disabled={disabled || Boolean(review) || (reviewer || data.resolution.phase !== 0 || !data.marketTerms.sealed || data.marketTerms.acceptanceBits !== 3)} className={shared.form} style={{border:0,padding:0,margin:0,minWidth:0}}><legend className="sr-only">Limit order</legend>
            <p>Available: {action === "BUY" ? `${feathers(seat.availableCash)} feathers` : `${outcome === "YES" ? seat.yes - seat.reservedYes : seat.no - seat.reservedNo} ${outcome} contracts`}</p>
            <div className={styles.toggle} role="group" aria-label="Order action">{(["BUY","SELL"] as const).map(value=><button key={value} type="button" aria-pressed={value===action} onClick={()=>setAction(value)}>{value==="BUY"?"Buy":"Sell"}</button>)}</div>
            <div className={styles.toggle} role="group" aria-label="Outcome">{(["YES","NO"] as const).map(value=><button key={value} type="button" aria-pressed={value===outcome} onClick={()=>setOutcome(value)}>{value}</button>)}</div>
            <label htmlFor={`${id}-price`}>Limit price (feathers)</label><input id={`${id}-price`} value={price} onChange={e=>setPrice(e.target.value)} inputMode="decimal" placeholder={`Below ${feathers(data.marketState.payoutMilli)}`} required />
            <label htmlFor={`${id}-quantity`}>Contracts</label><input id={`${id}-quantity`} value={quantity} onChange={e=>setQuantity(e.target.value)} inputMode="numeric" required />
            <label htmlFor={`${id}-tif`}>Time in force</label><div className={shared.select}><select id={`${id}-tif`} value={timeInForce} onChange={e=>setTimeInForce(e.target.value as typeof timeInForce)}><option value="GTC">Good until canceled</option><option value="IOC">Immediate or cancel</option><option value="FOK">Fill or kill</option></select><ChevronDown aria-hidden="true" /></div>
            <button className="button button-primary">Review {action.toLowerCase()}</button></fieldset>
            {reviewer && <p>Designated reviewers cannot trade this market.</p>}{data.resolution.phase !== 0 && <p>New orders are closed.</p>}{!data.marketTerms.sealed && <p>Trading opens after both reviewers accept and the terms are sealed.</p>}
          </form>}<Link href="/wallet" className="section-link">Manage wallet and account link</Link></section>
          {seat && <section className={shared.panel}><h2>Market collateral</h2><p>Wallet feathers: {data.walletTokenAmount === null ? "No token account" : feathers(data.walletTokenAmount)}</p><div className={shared.form}><label htmlFor={`${id}-cash`}>Feathers</label><input id={`${id}-cash`} value={cash} onChange={e=>setCash(e.target.value)} inputMode="decimal" placeholder="Amount" disabled={disabled || Boolean(review)} /><div className={shared.actions}><button className="button button-secondary" disabled={disabled || Boolean(review)} onClick={()=>escrow("deposit")}>Deposit</button><button className="button button-secondary" disabled={disabled || Boolean(review)} onClick={()=>escrow("withdrawal")}>Withdraw</button></div></div></section>}
          {review && <section className={`${shared.panel} ${styles.review}`} aria-label="Transaction review"><h2 ref={reviewHeading} tabIndex={-1}>Review transaction</h2><dl className={shared.facts}>{review.facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}<div><dt>Network fee estimate</dt><dd>{Number(review.fee)/1e9} SOL</dd></div><div><dt>Account deposit estimate</dt><dd>{Number(review.rent)/1e9} SOL</dd></div></dl>{review.intent.kind === "order" && <p>Orders may fill partially or fail as the book changes; FOK orders must fill completely.</p>}<div className={shared.actions}><button className="button button-secondary" disabled={preparing || Boolean(tx.busy)} onClick={()=>setReview(null)}>Cancel review</button><button className="button button-primary" disabled={disabled} onClick={()=>void approve()}>Approve transaction</button></div></section>}
        </div>
      </div>
    </>}
    {tx.receipts.length > 0 && <section className={shared.panel}><h2>Saved transactions</h2><ul className={shared.receipts}>{tx.receipts.map(receipt=><li key={receipt.signature}><strong>{receipt.status === "expired" ? "Expired · historical outcome unknown" : receipt.status}</strong><code>{receipt.signature}</code></li>)}</ul><button className="button button-secondary" disabled={Boolean(tx.busy)||preparing} onClick={()=>void tx.recover()}>Check transaction status</button>{!tx.ready && !tx.busy && <p>Resolve pending receipts before signing another transaction.</p>}</section>}
  </div>;
}

function Book({ orders, label }: { orders: readonly CanonicalBookOrder[]; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? orders : orders.slice(0, 20);
  return <div><table className={styles.book}>
    <caption>{label} · {orders.length} {orders.length === 1 ? "order" : "orders"}</caption>
    <thead><tr><th>YES price (feathers)</th><th>Contracts</th></tr></thead>
    <tbody>{visible.length ? visible.map(item => <tr key={item.id.toString()}><td>{feathers(item.canonicalYesPrice)}</td><td>{item.remaining.toString()}</td></tr>) : <tr><td colSpan={2}>No resting {label.toLowerCase()}.</td></tr>}</tbody>
  </table>{orders.length > 20 && <button className="button button-secondary" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Show fewer orders" : `Show all ${orders.length} orders`}</button>}</div>;
}
