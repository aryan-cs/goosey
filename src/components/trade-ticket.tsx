"use client";
import styles from "./trade-ticket.module.css";
import { FeatherIcon } from "./brand";
import { authPageHref } from "@/lib/auth-destination";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowRight, CheckCircle2, LoaderCircle, RotateCcw } from "lucide-react";
import { apiFetch } from "@/lib/client-api";
import { MAX_TRADE_QUANTITY, validTradeQuantity } from "@/lib/trade-quantity";
import { formatFeathers } from "@/lib/feather-format";
import { complementaryWholePercents, probabilityBpsToWholePercent, probabilityFractionLabel, probabilityFractionToBps } from "@/lib/probability-format";

type Outcome = "YES" | "NO";
type Action = "BUY" | "SELL";

export interface TradePricing {
  marketVersion: number;
  quantity: number;
  grossMilli: number | string;
  feeMilli: number | string;
  totalDebitMilli?: number | string;
  netCreditMilli?: number | string;
  averagePriceMilli: number | string;
  probabilityYesBeforeBps: number;
  probabilityYesAfterBps: number;
  payoutMilli: number | string;
}

export interface TradeQuote extends TradePricing {
  quoteId: string;
  expiresAt: string;
}

export interface TradeResult {
  tradeId?: string;
  status?: string;
  [key: string]: unknown;
}

export interface TradeTicketProps {
  marketId: string;
  marketTitle: string;
  yesProbability: number;
  noProbability?: number;
  balanceMilli?: number | string;
  signedIn?: boolean;
  initialOutcome?: Outcome;
  initialAction?: Action;
  onActionChange?: (action: Action) => void;
  /** Named event options buy/sell the underlying YES contract. */
  outcomeLabel?: string;
  returnTo?: string;
  csrfToken?: string;
  disabled?: boolean;
  quoteEndpoint?: string;
  previewEndpoint?: string;
  tradeEndpoint?: string;
  onExecuted?: (result: TradeResult) => void;
}

async function readResponse(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? `Request failed (${response.status})`;
    throw new Error(typeof message === "string" ? message : "The request could not be completed.");
  }
  return body;
}

function requestId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function TradeTicket({
  marketId, marketTitle, yesProbability, noProbability = 1 - yesProbability, balanceMilli,
  csrfToken, signedIn = true, initialOutcome = "YES", initialAction = "BUY", onActionChange, outcomeLabel, returnTo, disabled = false, quoteEndpoint, previewEndpoint, tradeEndpoint, onExecuted,
}: TradeTicketProps) {
  const router = useRouter();
  const [action, setAction] = useState<Action>(initialAction);
  const [outcome, setOutcome] = useState<Outcome>(outcomeLabel ? "YES" : initialOutcome);
  const [quantity, setQuantity] = useState(1);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [preview, setPreview] = useState<TradePricing | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [state, setState] = useState<"editing" | "quoting" | "review" | "submitting" | "success">("editing");
  const [error, setError] = useState<string | null>(null);
  const ticketRef = useRef<HTMLElement>(null);
  const executionKey = useRef<string | null>(null);
  const quoteUrl = quoteEndpoint ?? `/api/markets/${encodeURIComponent(marketId)}/quote`;
  const previewUrl = previewEndpoint ?? `/api/markets/${encodeURIComponent(marketId)}/preview`;
  const tradeUrl = tradeEndpoint ?? `/api/markets/${encodeURIComponent(marketId)}/trades`;
  const currentProbability = outcome === "YES" ? yesProbability : noProbability;
  const displayedProbability = complementaryWholePercents(probabilityFractionToBps(yesProbability));
  const quantityValid = validTradeQuantity(quantity);
  const milli = (value: number | string | bigint | undefined) => BigInt(value ?? 0);
  const featherText = (value: number | string | bigint | undefined) => {
    return formatFeathers(milli(value));
  };
  const quotedTotal = quote ? (action === "BUY" ? milli(quote.totalDebitMilli ?? milli(quote.grossMilli) + milli(quote.feeMilli)) : milli(quote.netCreditMilli ?? milli(quote.grossMilli) - milli(quote.feeMilli))) : 0n;
  const previewTotal = preview ? (action === "BUY" ? milli(preview.totalDebitMilli ?? milli(preview.grossMilli) + milli(preview.feeMilli)) : milli(preview.netCreditMilli ?? milli(preview.grossMilli) - milli(preview.feeMilli))) : 0n;
  const activePricing = quote ?? preview;
  const maxPayoutMilli = activePricing && quantityValid ? BigInt(quantity) * milli(activePricing.payoutMilli) : 0n;
  const potentialProfitMilli = action === "BUY" ? maxPayoutMilli - quotedTotal : quotedTotal;
  const previewProfitMilli = action === "BUY" ? maxPayoutMilli - previewTotal : previewTotal;

  useEffect(() => {
    if (!signedIn || disabled || state !== "editing" || !quantityValid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setPreviewing(true);
      setPreviewError(null);
      try {
        const response = await apiFetch(previewUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ side: outcome, action, quantity }),
          signal: controller.signal,
        });
        const body = await readResponse(response) as TradePricing;
        if (typeof body.grossMilli !== "number" && typeof body.grossMilli !== "string") throw new Error("The price preview was incomplete.");
        setPreview(body);
      } catch (reason) {
        if (controller.signal.aborted) return;
        setPreview(null);
        setPreviewError(reason instanceof Error ? reason.message : "Could not calculate the current price.");
      } finally {
        if (!controller.signal.aborted) setPreviewing(false);
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [action, disabled, outcome, previewUrl, quantity, quantityValid, signedIn, state]);

  useEffect(() => {
    if (state !== "success") return;
    const scrollContainer = ticketRef.current?.closest(".ticket-shell") as HTMLElement | null;
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }, [state]);

  function edit(next?: { action?: Action; outcome?: Outcome }) {
    if (next?.action) { setAction(next.action); onActionChange?.(next.action); }
    if (next?.outcome) setOutcome(next.outcome);
    setQuote(null); setPreview(null); setPreviewError(null); setError(null); setState("editing"); executionKey.current = null;
  }

  async function requestQuote() {
    if (!quantityValid) return setError("Enter a whole number from 1 to 100,000 contracts.");
    setState("quoting"); setError(null);
    try {
      const response = await apiFetch(quoteUrl, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestId(), ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body: JSON.stringify({ side: outcome, action, quantity }),
      });
      const body = await readResponse(response) as TradeQuote;
      if (!body.quoteId || (typeof body.grossMilli !== "number" && typeof body.grossMilli !== "string")) throw new Error("The quote response was incomplete.");
      setQuote(body); setState("review"); executionKey.current = requestId();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not get a quote."); setState("editing"); }
  }

  async function executeTrade() {
    if (!quote) return;
    setState("submitting"); setError(null);
    try {
      const protection = action === "BUY"
        ? { maxDebitMilli: String(quote.totalDebitMilli ?? milli(quote.grossMilli) + milli(quote.feeMilli)) }
        : { minCreditMilli: String(quote.netCreditMilli ?? (milli(quote.grossMilli) > milli(quote.feeMilli) ? milli(quote.grossMilli) - milli(quote.feeMilli) : 0n)) };
      const response = await apiFetch(tradeUrl, {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": executionKey.current ?? requestId(), ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
        body: JSON.stringify({ quoteId: quote.quoteId, marketVersion: quote.marketVersion, ...protection }),
      });
      const result = await readResponse(response) as TradeResult;
      setState("success"); onExecuted?.(result); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Trade could not be placed."); setState("review"); }
  }

  return (
    <section ref={ticketRef} className={`trade-ticket ${styles.ticket}`} aria-labelledby="trade-ticket-title">
      {state !== "success" && <>
        <div className="trade-ticket-header"><div><span className="eyebrow">Trade</span><h2 id="trade-ticket-title">{outcomeLabel ?? "Choose YES or NO"}</h2></div></div>
        {!outcomeLabel && <p className="trade-market-title">{marketTitle}</p>}
      </>}
      {state === "success" ? (
        <div className={`trade-success ${styles.successState}`} role="status"><CheckCircle2 /><h3 id="trade-ticket-title">Trade placed</h3><button className="button button-secondary" type="button" onClick={() => edit()}><RotateCcw /><span>Make another trade</span></button></div>
      ) : <>
        <div className="segmented" aria-label="Trade action">{(["BUY", "SELL"] as Action[]).map((value) => <button aria-pressed={action === value} className={action === value ? "active" : ""} onClick={() => edit({ action: value })} key={value}>{value === "BUY" ? "Buy" : "Sell"}</button>)}</div>
        {!outcomeLabel && <div className="side-grid" aria-label="Contract side">
          <button className={outcome === "YES" ? "yes selected" : "yes"} aria-pressed={outcome === "YES"} onClick={() => edit({ outcome: "YES" })}><span>Yes</span><strong>{displayedProbability.yes}%</strong></button>
          <button className={outcome === "NO" ? "no selected" : "no"} aria-pressed={outcome === "NO"} onClick={() => edit({ outcome: "NO" })}><span>No</span><strong>{displayedProbability.no}%</strong></button>
        </div>}
        <div className={styles.quantityGroup}><label className="field-label" htmlFor="trade-quantity">Contracts</label>
        <div className="quantity-input"><input id="trade-quantity" inputMode="numeric" min={1} max={MAX_TRADE_QUANTITY} step={1} type="number" value={quantity} aria-invalid={!quantityValid} aria-describedby={!quantityValid ? "trade-quantity-error" : undefined} disabled={state !== "editing"} onChange={(event) => { setQuantity(event.currentTarget.valueAsNumber || 0); setPreview(null); setPreviewError(null); setError(null); }} /><span>contracts</span></div>
        {!quantityValid && <p id="trade-quantity-error" className="form-error" role="alert">Enter a whole number from 1 to 100,000 contracts.</p>}
        {state === "editing" && <div className="quick-values" aria-label="Quick quantities">{[1, 5, 10, 25].map((value) => <button onClick={() => { setQuantity(value); setPreview(null); setPreviewError(null); }} key={value}>{value}</button>)}</div>}
        </div>
        <dl className="trade-breakdown">
          {quote ? <>
            <div><dt>Average price</dt><dd><FeatherIcon width={15} height={15} /> {featherText(quote.averagePriceMilli)}</dd></div>
            <div><dt>Forecast after trade</dt><dd>{probabilityBpsToWholePercent(quote.probabilityYesAfterBps)}% {outcomeLabel ?? "Yes"}</dd></div>
            <div><dt>Fee</dt><dd><FeatherIcon width={15} height={15} /> {featherText(quote.feeMilli)}</dd></div>
            {action === "BUY" ? <div className={styles.moneySummary}>
              <div className={styles.primaryAmount}><dt>You pay now</dt><dd><FeatherIcon width={15} height={15} /> {featherText(quotedTotal)}</dd></div>
              <div><dt>Total return if correct</dt><dd><FeatherIcon width={15} height={15} /> {featherText(maxPayoutMilli)}</dd></div>
              <div><dt>Profit if correct</dt><dd><FeatherIcon width={15} height={15} /> {featherText(potentialProfitMilli)}</dd></div>
            </div> : <div className={`${styles.primaryAmount} trade-total`}><dt>You receive now</dt><dd><FeatherIcon width={15} height={15} /> {featherText(quotedTotal)}</dd></div>}
          </> : preview ? <>
            <div><dt>Current forecast</dt><dd>{probabilityFractionLabel(currentProbability)}</dd></div>
            <div><dt>Average price</dt><dd><FeatherIcon width={15} height={15} /> {featherText(preview.averagePriceMilli)}</dd></div>
            <div><dt>Fee</dt><dd><FeatherIcon width={15} height={15} /> {featherText(preview.feeMilli)}</dd></div>
            {action === "BUY" ? <div className={styles.moneySummary}>
              <div className={styles.primaryAmount}><dt>Current cost</dt><dd><FeatherIcon width={15} height={15} /> {featherText(previewTotal)}</dd></div>
              <div><dt>Total return if correct</dt><dd><FeatherIcon width={15} height={15} /> {featherText(maxPayoutMilli)}</dd></div>
              <div><dt>Potential profit</dt><dd><FeatherIcon width={15} height={15} /> {featherText(previewProfitMilli)}</dd></div>
            </div> : <div className={styles.primaryAmount}><dt>Current proceeds</dt><dd><FeatherIcon width={15} height={15} /> {featherText(previewTotal)}</dd></div>}
            {balanceMilli !== undefined && <div><dt>Available</dt><dd><FeatherIcon width={15} height={15} /> {featherText(balanceMilli)}</dd></div>}
          </> : <><div><dt>Current forecast</dt><dd>{probabilityFractionLabel(currentProbability)}</dd></div><div className={styles.calculating}><dt>Current price</dt><dd>{previewing ? "Calculating…" : "—"}</dd></div></>}
        </dl>
        {state === "editing" && preview && <p className={styles.estimateNote}>Live preview based on the current market. Review to lock an exact price for 30 seconds.</p>}
        {state === "editing" && previewError && <p className="form-error" role="alert"><AlertCircle /> {previewError}</p>}
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}
        {state === "review" && <p className="review-note">Check the price before you confirm. Quotes can change or expire.</p>}
        <div className="trade-actions">
          {state === "review" && <button className="button button-ghost" onClick={() => edit()}>Edit</button>}
          <button className="button button-primary trade-submit" disabled={disabled || state === "quoting" || state === "submitting" || !quantityValid} onClick={!signedIn ? () => router.push(authPageHref("/login", returnTo ?? `${window.location.pathname}${window.location.search}`)) : state === "review" ? executeTrade : requestQuote}>
            {(state === "quoting" || state === "submitting") && <LoaderCircle className="spin" />}{!signedIn ? "Sign in to trade" : state === "editing" ? "Review trade" : state === "quoting" ? "Getting quote…" : state === "review" ? `${action === "BUY" ? "Buy" : "Sell"} ${quantity} ${outcomeLabel ?? outcome}` : "Placing trade…"}<ArrowRight />
          </button>
        </div>
      </>}
    </section>
  );
}
