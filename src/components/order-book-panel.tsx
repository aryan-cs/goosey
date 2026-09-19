"use client";
import { FeatherIcon } from "./brand";
import Link from "next/link";
import { authPageHref } from "@/lib/auth-destination";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/client-api";
import { orderEntryHref, parseOrderEntry } from "@/lib/order-entry";
import { ORDER_BOOK_LIMITS } from "@/lib/order-book";
import { OrderAmendment, outcomeLimitPrice } from "./order-amendment";
import { startVisiblePolling } from "@/lib/visible-polling";
import { orderPlacementMessage, orderRejectionMessage, parseOrderOptions, type OrderTimeInForce } from "@/lib/order-options";
import styles from "./order-options.module.css";
import layout from "./order-book-panel.module.css";

type Outcome = "YES" | "NO";
type Action = "BUY" | "SELL";
type BookLevel = { priceMilli: string; quantity: string; orderCount: number };
type BookResponse = { bids: BookLevel[]; asks: BookLevel[]; sequence: string; payoutMilli: string };
type PrivateOrder = {
  orderId: string;
  outcome: Outcome;
  action: Action;
  limitPriceMilli: string;
  remainingQuantity: number;
  filledQuantity: number;
  canceledQuantity?: number;
  status: string;
  version: number;
  timeInForce?: string;
  postOnly?: boolean;
  expiresAt?: string | null;
};

function requestId(): string { return crypto.randomUUID(); }

function featherAmount(value: string | bigint): string {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  return `${amount / 1_000n}.${(amount % 1_000n).toString().padStart(3, "0")}`;
}

async function readJson(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message ?? "The order request could not be completed.");
  return body;
}

export function OrderBookPanel({ marketSlug, marketTitle, payoutMilli, feeBps, signedIn, disabled, initialOutcome = "YES", initialAction = "BUY" }: {
  marketSlug: string;
  marketTitle: string;
  payoutMilli: string;
  feeBps: number;
  signedIn: boolean;
  disabled: boolean;
  initialOutcome?: Outcome;
  initialAction?: Action;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [action, setAction] = useState<Action>(initialAction);
  const [price, setPrice] = useState(() => featherAmount(BigInt(payoutMilli) / 2n));
  const [quantity, setQuantity] = useState(1);
  const [timeInForce, setTimeInForce] = useState<OrderTimeInForce>("GTC");
  const [postOnly, setPostOnly] = useState(false);
  const [expiresAtLocal, setExpiresAtLocal] = useState("");
  const [book, setBook] = useState<BookResponse | null>(null);
  const [orders, setOrders] = useState<PrivateOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const placementAttempt = useRef<{ key: string; body: string } | null>(null);
  const operationPending = useRef(false);
  const editingOrders = useRef(new Set<string>());
  const activeRead = useRef<AbortController | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = window.setTimeout(abort, 10_000);
    try {
      const [bookResponse, ordersResponse] = await Promise.all([
        fetch(`/api/v1/markets/${encodeURIComponent(marketSlug)}/orderbook?depth=8`, { cache: "no-store", signal: controller.signal }),
        signedIn ? fetch(`/api/v1/orders?marketSlug=${encodeURIComponent(marketSlug)}&status=OPEN&status=PARTIALLY_FILLED&limit=50`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }) : Promise.resolve(null),
      ]);
      if (ordersResponse?.status === 401 && !controller.signal.aborted) setOrders([]);
      const [nextBook, privateBody] = await Promise.all([
        readJson(bookResponse) as Promise<BookResponse>,
        ordersResponse ? readJson(ordersResponse) as Promise<{ orders: PrivateOrder[] }> : Promise.resolve(null),
      ]);
      if (controller.signal.aborted || activeRead.current !== controller) return;
      if (!Array.isArray(nextBook.bids) || !Array.isArray(nextBook.asks) || (privateBody && !Array.isArray(privateBody.orders))) throw new Error("Order updates could not be read.");
      setBook(nextBook);
      setOrders(privateBody?.orders ?? []);
      const visibleIds = new Set(privateBody?.orders.map((order) => order.orderId) ?? []);
      for (const id of editingOrders.current) if (!visibleIds.has(id)) editingOrders.current.delete(id);
      setUpdatedAt(new Date());
      setFeedError(null);
    } catch (reason) {
      if (activeRead.current !== controller || signal?.aborted) return;
      setFeedError("Updates interrupted. Displayed orders may be out of date. Retrying automatically.");
      throw reason;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (activeRead.current === controller) activeRead.current = null;
    }
  }, [marketSlug, signedIn]);

  useEffect(() => {
    const stop = startVisiblePolling({
      run: load,
      isPaused: () => operationPending.current || editingOrders.current.size > 0,
      onError: () => setFeedError("Updates interrupted. Displayed orders may be out of date. Retrying automatically."),
    });
    return () => { stop(); activeRead.current?.abort(); activeRead.current = null; };
  }, [load]);

  function resetAttempt() {
    placementAttempt.current = null;
    setError(null);
    setMessage(null);
  }

  function interruptRead() {
    activeRead.current?.abort();
    activeRead.current = null;
  }

  async function place(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationPending.current || disabled) return;
    if (!signedIn) { router.push(authPageHref("/login", orderEntryHref(marketSlug, outcome, action))); return; }
    const entry = parseOrderEntry(price, quantity, BigInt(payoutMilli), feeBps, action);
    if (!entry.valid) {
      setError(entry.message);
      return;
    }
    // Freeze the payload as well as its key. A lost response must be replayable
    // even after the originally submitted expiration has passed.
    if (!placementAttempt.current) {
      const options = parseOrderOptions({ timeInForce, postOnly, expiresAtLocal });
      if (!options.valid) { setError(options.message); return; }
      placementAttempt.current = {
        key: requestId(),
        body: JSON.stringify({ marketSlug, clientOrderId: requestId(), outcome, action,
          limitPriceMilli: entry.priceMilli.toString(), quantity, timeInForce: options.timeInForce,
          postOnly: options.postOnly, expiresAt: options.expiresAt,
          selfTradePrevention: "CANCEL_AGGRESSOR", cancelOnPause: true, reduceOnly: false }),
      };
    }
    operationPending.current = true;
    interruptRead();
    const attempt = placementAttempt.current;
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch("/api/v1/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.key },
        body: attempt.body,
      });
      const body = await response.json().catch(() => ({})) as { accepted?: boolean; order?: PrivateOrder; reason?: string; error?: { message?: string } };
      if (response.status === 422 && body.accepted === false) {
        // A confirmed no-fill rejection completes this attempt. Clicking again
        // evaluates current liquidity instead of replaying the old rejection.
        placementAttempt.current = null;
        throw new Error(orderRejectionMessage(body.reason ?? ""));
      }
      if (!response.ok || body.accepted !== true || !body.order) throw new Error(body.error?.message ?? "The order could not be confirmed. Retry to check the same request.");
      setMessage(orderPlacementMessage(body.order));
      placementAttempt.current = null;
      await load().catch(() => setError("Order saved, but the latest book could not load. Refresh to check its status."));
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be placed."); }
    finally { operationPending.current = false; setBusy(false); }
  }

  async function cancel(order: PrivateOrder) {
    if (operationPending.current) return;
    operationPending.current = true;
    interruptRead();
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch(`/api/v1/orders/${encodeURIComponent(order.orderId)}`, { method: "DELETE", credentials: "same-origin", headers: { "Idempotency-Key": requestId(), "If-Match": `order-version-${order.version}` } });
      await readJson(response);
      setMessage("Order canceled and reserved feathers released.");
      await load().catch(() => setError("Order canceled, but the latest book could not load. Refresh to check its status."));
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be canceled."); }
    finally { operationPending.current = false; setBusy(false); }
  }

  const entry = parseOrderEntry(price, quantity, BigInt(payoutMilli), feeBps, action);
  const maximumPrice = featherAmount(BigInt(payoutMilli) - 1n);
  async function refresh() {
    setError(null);
    await load().catch((reason) => setError(reason instanceof Error ? reason.message : "Order book unavailable."));
  }

  async function amendmentComplete(result: "saved" | "stale") {
    setMessage(result === "saved" ? "Remaining order replaced. Completed fills are unchanged." : "The order changed. Review the refreshed orders before editing again.");
    await load().catch(() => setError("Orders could not refresh. Use Refresh to check the latest status."));
    router.refresh();
  }

  return <aside id="order-book" className={`order-book-panel ${styles.panel} ${layout.panel}`} aria-labelledby="order-entry-heading">
    <section className="trade-ticket order-entry-card">
      <div className="trade-ticket-header"><div><span className="eyebrow">Order book</span><h2 id="order-entry-heading">Place a limit order</h2></div><button className="icon-button" type="button" aria-label="Refresh order book" disabled={busy} onClick={() => void refresh()}><RefreshCw /></button></div>
      <p className="trade-market-title">{marketTitle}</p>
      <div className="segmented" aria-label="Order action">{(["BUY", "SELL"] as Action[]).map((value) => <button type="button" disabled={busy} aria-pressed={action === value} className={action === value ? "active" : ""} onClick={() => { setAction(value); resetAttempt(); }} key={value}>{value === "BUY" ? "Buy" : "Sell"}</button>)}</div>
      <div className="side-grid" aria-label="Contract side">{(["YES", "NO"] as Outcome[]).map((value) => <button type="button" disabled={busy} className={`${value.toLowerCase()}${outcome === value ? " selected" : ""}`} aria-pressed={outcome === value} onClick={() => { setOutcome(value); resetAttempt(); }} key={value}><span>{value === "YES" ? "Yes" : "No"}</span></button>)}</div>
      <form onSubmit={place} className="order-entry-form">
        <div className={layout.entryFields}>
          <div><label className="field-label" htmlFor="limit-price">Limit price (<FeatherIcon width={15} height={15} />)</label><input id="limit-price" name="limitPrice" type="number" min="0.001" max={maximumPrice} step="0.001" value={price} disabled={busy || disabled} onChange={(event) => { setPrice(event.currentTarget.value); resetAttempt(); }} /></div>
          <div><label className="field-label" htmlFor="order-quantity">Contracts</label><input id="order-quantity" name="quantity" type="number" inputMode="numeric" min={1} max={ORDER_BOOK_LIMITS.maxQuantity} step={1} value={quantity} disabled={busy || disabled} onChange={(event) => { setQuantity(event.currentTarget.valueAsNumber || 0); resetAttempt(); }} /></div>
        </div>
        <details className={styles.options}>
          <summary>Advanced order options</summary>
          <div className={styles.fields}>
            <label className="field-label" htmlFor="order-duration">Order duration</label>
            <select id="order-duration" value={timeInForce} disabled={busy || disabled} onChange={(event) => {
              const value = event.currentTarget.value as OrderTimeInForce;
              setTimeInForce(value);
              if (value !== "GTC") { setPostOnly(false); setExpiresAtLocal(""); }
              resetAttempt();
            }} aria-describedby="order-duration-help">
              <option value="GTC">Good until canceled</option>
              <option value="IOC">Immediate or cancel</option>
              <option value="FOK">Fill or kill</option>
            </select>
            <p id="order-duration-help" className="muted-copy">{timeInForce === "GTC" ? "Unfilled contracts stay on the book until canceled, expired, or the market closes." : timeInForce === "IOC" ? "Fill whatever is available now at your limit or better, then cancel the rest. Nothing rests on the book." : "Fill every contract now at your limit or better, or reject the entire order. No partial fills."}</p>
            <label className={styles.checkbox} htmlFor="order-post-only"><input id="order-post-only" type="checkbox" checked={postOnly} disabled={busy || disabled || timeInForce !== "GTC"} onChange={(event) => { setPostOnly(event.currentTarget.checked); resetAttempt(); }} /><span>Post-only (rest on the book)</span></label>
            <p className="muted-copy">Post-only rejects the entire order if it would trade immediately. Available only for good-until-canceled orders.</p>
            <label className="field-label" htmlFor="order-expiration">Expiration (your local time)</label>
            <input id="order-expiration" type="datetime-local" step="60" value={expiresAtLocal} disabled={busy || disabled || timeInForce !== "GTC"} onChange={(event) => { setExpiresAtLocal(event.currentTarget.value); resetAttempt(); }} aria-describedby="order-expiration-help" />
            <p id="order-expiration-help" className="muted-copy">Optional for good-until-canceled orders. Leave blank for no custom expiration. Unfilled backing is released when the order expires.</p>
            <Link className={styles.helpLink} href="/rules#order-options">How order types and reservations work</Link>
          </div>
        </details>
        <dl className="trade-breakdown"><div><dt>{action === "BUY" ? "Maximum reserved (incl. fee)" : "Net proceeds at limit"}</dt><dd>{entry.valid ? featherAmount(entry.cashMilli) : "—"} <FeatherIcon width={15} height={15} /></dd></div><div><dt>Fee at limit</dt><dd>{entry.valid ? featherAmount(entry.feeMilli) : "—"} <FeatherIcon width={15} height={15} /></dd></div><div><dt>Time in force</dt><dd>{timeInForce === "IOC" ? "Immediate or cancel" : timeInForce === "FOK" ? "Fill or kill" : expiresAtLocal ? "Good until expiration" : "Good until canceled"}{postOnly ? " · Post-only" : ""}</dd></div></dl>
        {!entry.valid && <p className="muted-copy" role="status">{entry.message}</p>}
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}{message && <p className="success-message" role="status">{message}</p>}
        <button className="button button-primary trade-submit" type="submit" disabled={busy || disabled || !entry.valid}>{busy ? <LoaderCircle className="spin" /> : null}{signedIn ? "Place limit order" : "Sign in to place an order"}</button>
      </form>
    </section>
    <p className={layout.feedStatus} role="status">{feedError ?? (updatedAt ? `Auto-refresh every 5 seconds · Updated ${updatedAt.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}. Updates pause while editing an order.` : "Connecting to the order book…")}</p>
    <section className="order-depth-card" aria-labelledby="book-depth-heading"><div className="section-heading"><div><span className="eyebrow">Live depth</span><h2 id="book-depth-heading">YES order book</h2></div><span>{book ? `#${book.sequence}` : "Loading"}</span></div><div className="order-depth-grid"><div><strong>Bids</strong>{book?.bids.length ? book.bids.map((level) => <div className="depth-row bid" key={`bid-${level.priceMilli}`}><span>{featherAmount(level.priceMilli)} <FeatherIcon width={15} height={15} /></span><span>{level.quantity} · {level.orderCount}</span></div>) : <p className="muted-copy">No bids yet.</p>}</div><div><strong>Asks</strong>{book?.asks.length ? book.asks.map((level) => <div className="depth-row ask" key={`ask-${level.priceMilli}`}><span>{featherAmount(level.priceMilli)} <FeatherIcon width={15} height={15} /></span><span>{level.quantity} · {level.orderCount}</span></div>) : <p className="muted-copy">No asks yet.</p>}</div></div></section>
    {signedIn && <section className="open-orders-card" aria-labelledby="open-orders-heading"><div className="section-heading"><div><span className="eyebrow">Your orders</span><h2 id="open-orders-heading">Open orders</h2></div><span>{orders.length}</span></div>{orders.length ? <div className="open-order-list">{orders.map((order) => <div key={order.orderId}>
      <article><div><strong>{order.action} {order.remainingQuantity} {order.outcome}</strong><span>{featherAmount(outcomeLimitPrice(order, payoutMilli))} <FeatherIcon width={15} height={15} /> · {order.filledQuantity} filled{order.postOnly ? " · Post-only" : ""}</span>{order.expiresAt && <span>Expires <time dateTime={order.expiresAt}>{new Date(order.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time> (local time)</span>}</div><button className="button button-ghost" type="button" disabled={busy} onClick={() => void cancel(order)}><X /> Cancel</button></article>
      {order.timeInForce === "GTC" && order.remainingQuantity > 0 && <OrderAmendment order={order} payoutMilli={payoutMilli} disabled={busy || disabled} onEditingChange={(value) => { if (value) { editingOrders.current.add(order.orderId); interruptRead(); } else editingOrders.current.delete(order.orderId); }} onBusyChange={(value) => { operationPending.current = value; if (value) interruptRead(); setBusy(value); }} onComplete={amendmentComplete} />}
    </div>)}</div> : <p className="muted-copy">No resting orders in this market.</p>}</section>}
  </aside>;
}
