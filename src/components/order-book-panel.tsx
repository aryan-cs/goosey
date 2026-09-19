"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { apiFetch } from "@/lib/client-api";

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
  status: string;
  version: number;
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

export function OrderBookPanel({ marketSlug, marketTitle, payoutMilli, signedIn, disabled }: {
  marketSlug: string;
  marketTitle: string;
  payoutMilli: string;
  signedIn: boolean;
  disabled: boolean;
}) {
  const router = useRouter();
  const [outcome, setOutcome] = useState<Outcome>("YES");
  const [action, setAction] = useState<Action>("BUY");
  const [price, setPrice] = useState("50.000");
  const [quantity, setQuantity] = useState(1);
  const [book, setBook] = useState<BookResponse | null>(null);
  const [orders, setOrders] = useState<PrivateOrder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const placementKey = useRef(requestId());

  const load = useCallback(async () => {
    const [bookResponse, ordersResponse] = await Promise.all([
      fetch(`/api/v1/markets/${encodeURIComponent(marketSlug)}/orderbook?depth=8`, { cache: "no-store" }),
      signedIn ? fetch(`/api/v1/orders?marketSlug=${encodeURIComponent(marketSlug)}&status=OPEN&status=PARTIALLY_FILLED&limit=50`, { credentials: "same-origin", cache: "no-store" }) : Promise.resolve(null),
    ]);
    setBook(await readJson(bookResponse) as BookResponse);
    if (ordersResponse) {
      const body = await readJson(ordersResponse) as { orders?: PrivateOrder[] };
      setOrders(body.orders ?? []);
    }
  }, [marketSlug, signedIn]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void load().catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Order book unavailable."); });
    }, 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [load]);

  function resetAttempt() {
    placementKey.current = requestId();
    setError(null);
    setMessage(null);
  }

  async function place(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!signedIn) { router.push("/login"); return; }
    const priceNumber = Number(price);
    const payout = Number(BigInt(payoutMilli)) / 1_000;
    if (!Number.isFinite(priceNumber) || priceNumber <= 0 || priceNumber >= payout || !Number.isSafeInteger(quantity) || quantity < 1) {
      setError(`Enter a price above 0 and below ${payout.toFixed(3)}, plus at least one contract.`);
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch("/api/v1/orders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": placementKey.current },
        body: JSON.stringify({ marketSlug, clientOrderId: requestId(), outcome, action, limitPriceMilli: BigInt(Math.round(priceNumber * 1_000)).toString(), quantity, timeInForce: "GTC", postOnly: false, selfTradePrevention: "CANCEL_AGGRESSOR", cancelOnPause: true, reduceOnly: false }),
      });
      const body = await readJson(response) as { accepted?: boolean; order?: PrivateOrder; reason?: string };
      if (!body.accepted || !body.order) throw new Error(body.reason ?? "The order was not accepted.");
      setMessage(body.order.status === "FILLED" ? "Order filled." : "Limit order placed. You can cancel its unfilled quantity below.");
      placementKey.current = requestId();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be placed."); }
    finally { setBusy(false); }
  }

  async function cancel(order: PrivateOrder) {
    setBusy(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch(`/api/v1/orders/${encodeURIComponent(order.orderId)}`, { method: "DELETE", credentials: "same-origin", headers: { "Idempotency-Key": requestId(), "If-Match": `order-version-${order.version}` } });
      await readJson(response);
      setMessage("Order canceled and reserved feathers released.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The order could not be canceled."); }
    finally { setBusy(false); }
  }

  const priceMilli = Number.isFinite(Number(price)) ? BigInt(Math.max(0, Math.round(Number(price) * 1_000))) : 0n;
  const estimated = priceMilli * BigInt(Math.max(0, quantity));

  return <aside id="order-book" className="order-book-panel" aria-labelledby="order-entry-heading">
    <section className="trade-ticket order-entry-card">
      <div className="trade-ticket-header"><div><span className="eyebrow">Order book</span><h2 id="order-entry-heading">Place a limit order</h2></div><button className="icon-button" type="button" aria-label="Refresh order book" onClick={() => void load()}><RefreshCw /></button></div>
      <p className="trade-market-title">{marketTitle}</p>
      <div className="segmented" aria-label="Order action">{(["BUY", "SELL"] as Action[]).map((value) => <button type="button" aria-pressed={action === value} className={action === value ? "active" : ""} onClick={() => { setAction(value); resetAttempt(); }} key={value}>{value === "BUY" ? "Buy" : "Sell"}</button>)}</div>
      <div className="side-grid" aria-label="Contract side">{(["YES", "NO"] as Outcome[]).map((value) => <button type="button" className={`${value.toLowerCase()}${outcome === value ? " selected" : ""}`} aria-pressed={outcome === value} onClick={() => { setOutcome(value); resetAttempt(); }} key={value}><span>{value === "YES" ? "Yes" : "No"}</span></button>)}</div>
      <form onSubmit={place} className="order-entry-form">
        <label className="field-label" htmlFor="limit-price">Limit price (🪶)</label><input id="limit-price" name="limitPrice" type="number" min="0.001" max="99.999" step="0.001" value={price} disabled={busy || disabled} onChange={(event) => { setPrice(event.currentTarget.value); resetAttempt(); }} />
        <label className="field-label" htmlFor="order-quantity">Contracts</label><input id="order-quantity" name="quantity" type="number" inputMode="numeric" min={1} step={1} value={quantity} disabled={busy || disabled} onChange={(event) => { setQuantity(event.currentTarget.valueAsNumber || 0); resetAttempt(); }} />
        <dl className="trade-breakdown"><div><dt>{action === "BUY" ? "Maximum reserved" : "Limit proceeds"}</dt><dd>{featherAmount(estimated)} 🪶</dd></div><div><dt>Time in force</dt><dd>Good until canceled</dd></div></dl>
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}{message && <p className="success-message" role="status">{message}</p>}
        <button className="button button-primary trade-submit" type="submit" disabled={busy || disabled || quantity < 1}>{busy ? <LoaderCircle className="spin" /> : null}{signedIn ? "Place limit order" : "Sign in to place an order"}</button>
      </form>
    </section>
    <section className="order-depth-card" aria-labelledby="book-depth-heading"><div className="section-heading"><div><span className="eyebrow">Live depth</span><h2 id="book-depth-heading">YES order book</h2></div><span>{book ? `#${book.sequence}` : "Loading"}</span></div><div className="order-depth-grid"><div><strong>Bids</strong>{book?.bids.length ? book.bids.map((level) => <div className="depth-row bid" key={`bid-${level.priceMilli}`}><span>{featherAmount(level.priceMilli)} 🪶</span><span>{level.quantity} · {level.orderCount}</span></div>) : <p className="muted-copy">No bids yet.</p>}</div><div><strong>Asks</strong>{book?.asks.length ? book.asks.map((level) => <div className="depth-row ask" key={`ask-${level.priceMilli}`}><span>{featherAmount(level.priceMilli)} 🪶</span><span>{level.quantity} · {level.orderCount}</span></div>) : <p className="muted-copy">No asks yet.</p>}</div></div></section>
    {signedIn && <section className="open-orders-card" aria-labelledby="open-orders-heading"><div className="section-heading"><div><span className="eyebrow">Your orders</span><h2 id="open-orders-heading">Open orders</h2></div><span>{orders.length}</span></div>{orders.length ? <div className="open-order-list">{orders.map((order) => <article key={order.orderId}><div><strong>{order.action} {order.remainingQuantity} {order.outcome}</strong><span>{featherAmount(order.limitPriceMilli)} 🪶 · {order.filledQuantity} filled</span></div><button className="button button-ghost" type="button" disabled={busy} onClick={() => void cancel(order)}><X /> Cancel</button></article>)}</div> : <p className="muted-copy">No resting orders in this market.</p>}</section>}
  </aside>;
}
