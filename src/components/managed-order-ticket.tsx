"use client";

import { AlertCircle, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";

import { FeatherIcon } from "@/components/brand";
import { authPageHref } from "@/lib/auth-destination";
import { apiFetch } from "@/lib/client-api";
import { orderEntryHref, parseOrderEntry } from "@/lib/order-entry";

type Outcome = "YES" | "NO";
type Action = "BUY" | "SELL";
type Attempt = Readonly<{ key: string; body: string }>;
type CommandStatus = Readonly<{ id: string; status: string }>;

function requestId() { return crypto.randomUUID(); }
function feathers(value: bigint) { return `${value / 1_000n}.${(value % 1_000n).toString().padStart(3, "0")}`; }

async function pollCommand(id: string): Promise<"finalized" | "unknown" | "failed"> {
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/v1/commands/${encodeURIComponent(id)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({})) as CommandStatus & { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "Order status is unavailable.");
    if (body.status === "FINALIZED" || body.status === "PROJECTED") return "finalized";
    if (body.status === "FAILED_TERMINAL") return "failed";
    if (body.status === "UNKNOWN") return "unknown";
    await new Promise(resolve => window.setTimeout(resolve, 1_000));
  }
  return "unknown";
}

export function ManagedOrderTicket({ marketSlug, payoutMilli, feeBps, signedIn, disabled,
  initialOutcome = "YES", initialAction = "BUY" }: {
  marketSlug: string;
  payoutMilli: string;
  feeBps: number;
  signedIn: boolean;
  disabled: boolean;
  initialOutcome?: Outcome;
  initialAction?: Action;
}) {
  const router = useRouter();
  const payout = BigInt(payoutMilli);
  const [outcome, setOutcome] = useState<Outcome>(initialOutcome);
  const [action, setAction] = useState<Action>(initialAction);
  const [price, setPrice] = useState(feathers(payout / 2n));
  const [quantity, setQuantity] = useState(1);
  const [timeInForce, setTimeInForce] = useState<"GTC" | "IOC" | "FOK">("GTC");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const entry = parseOrderEntry(price, quantity, payout, feeBps, action);
  const maximumPrice = feathers(payout - 1n);

  function reset() { attempt.current = null; setMessage(null); setError(null); }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    if (!signedIn) {
      router.push(authPageHref("/login", orderEntryHref(marketSlug, outcome, action)));
      return;
    }
    if (!entry.valid) { setError(entry.message); return; }
    if (!attempt.current) {
      const key = requestId();
      attempt.current = { key, body: JSON.stringify({ marketSlug, clientOrderId: key,
        outcome, action, limitPriceMilli: entry.priceMilli.toString(), quantity, timeInForce, postOnly: false,
        selfTradePrevention: "CANCEL_AGGRESSOR", expiresAt: null, cancelOnPause: true, reduceOnly: false }) };
    }
    setBusy(true); setError(null); setMessage("Preparing your order…");
    try {
      const response = await apiFetch("/api/v1/orders", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key }, body: attempt.current.body });
      const body = await response.json().catch(() => ({})) as { accepted?: boolean; pending?: boolean;
        command?: CommandStatus; error?: { message?: string } };
      if (!response.ok || body.accepted !== true || body.pending !== true || !body.command?.id) {
        throw new Error(body.error?.message ?? "The order could not be accepted.");
      }
      setMessage("Order accepted. Waiting for final confirmation…");
      const outcomeStatus = await pollCommand(body.command.id);
      if (outcomeStatus === "failed") throw new Error("The order was rejected during final confirmation.");
      if (outcomeStatus === "unknown") {
        setMessage("Confirmation is taking longer than expected. Your order is safely recorded and will not be duplicated.");
      } else {
        setMessage("Order finalized.");
        attempt.current = null;
        router.refresh();
      }
    } catch (reason) {
      setMessage(null);
      setError(reason instanceof Error ? reason.message : "The order could not be placed.");
    } finally { setBusy(false); }
  }

  return <section className="trade-ticket order-entry-card" aria-labelledby="managed-order-heading">
    <div className="trade-ticket-header"><div><span className="eyebrow">Order book</span><h2 id="managed-order-heading">Place a limit order</h2></div></div>
    <div className="segmented" aria-label="Order action">{(["BUY", "SELL"] as const).map(value =>
      <button type="button" disabled={busy} aria-pressed={action === value} className={action === value ? "active" : ""}
        onClick={() => { setAction(value); reset(); }} key={value}>{value === "BUY" ? "Buy" : "Sell"}</button>)}</div>
    <div className="side-grid" aria-label="Contract side">{(["YES", "NO"] as const).map(value =>
      <button type="button" disabled={busy} aria-pressed={outcome === value} className={`${value.toLowerCase()}${outcome === value ? " selected" : ""}`}
        onClick={() => { setOutcome(value); reset(); }} key={value}>{value === "YES" ? "Yes" : "No"}</button>)}</div>
    <form className="order-entry-form" onSubmit={submit}>
      <label className="field-label" htmlFor="managed-limit-price">Limit price (<FeatherIcon width={15} height={15} />)</label>
      <input id="managed-limit-price" type="number" min="0.001" max={maximumPrice} step="0.001" value={price}
        disabled={busy || disabled} onChange={event => { setPrice(event.currentTarget.value); reset(); }} />
      <label className="field-label" htmlFor="managed-quantity">Contracts</label>
      <input id="managed-quantity" type="number" inputMode="numeric" min={1} max={10_000_000} step={1} value={quantity}
        disabled={busy || disabled} onChange={event => { setQuantity(event.currentTarget.valueAsNumber || 0); reset(); }} />
      <label className="field-label" htmlFor="managed-duration">Order duration</label>
      <select id="managed-duration" value={timeInForce} disabled={busy || disabled}
        onChange={event => { setTimeInForce(event.currentTarget.value as typeof timeInForce); reset(); }}>
        <option value="GTC">Good until canceled</option><option value="IOC">Immediate or cancel</option><option value="FOK">Fill or kill</option>
      </select>
      <dl className="trade-breakdown"><div><dt>{action === "BUY" ? "Maximum reserved" : "Limit proceeds"}</dt><dd>{entry.valid ? feathers(entry.cashMilli) : "—"} <FeatherIcon width={15} height={15} /></dd></div><div><dt>Fee at limit</dt><dd>{entry.valid ? feathers(entry.feeMilli) : "—"} <FeatherIcon width={15} height={15} /></dd></div></dl>
      {!entry.valid && <p className="muted-copy" role="status">{entry.message}</p>}
      {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}
      {message && <p className="success-message" role="status">{message}</p>}
      <button className="button button-primary trade-submit" type="submit" disabled={busy || disabled || !entry.valid}>
        {busy && <LoaderCircle className="spin" />}{signedIn ? "Place limit order" : "Sign in to place an order"}
      </button>
    </form>
  </section>;
}
