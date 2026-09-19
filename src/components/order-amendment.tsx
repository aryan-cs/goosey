"use client";

import { type FormEvent, useId, useRef, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { parseOrderEntry } from "@/lib/order-entry";
import { ORDER_BOOK_LIMITS } from "@/lib/order-book";

export type AmendableOrder = {
  orderId: string;
  version: number;
  outcome: "YES" | "NO";
  action: "BUY" | "SELL";
  limitPriceMilli: string;
  remainingQuantity: number;
};

/** Private-order reads use canonical YES prices; entry/PATCH uses the outcome price. */
export function outcomeLimitPrice(order: Pick<AmendableOrder, "outcome" | "limitPriceMilli">, payoutMilli: string): bigint {
  return order.outcome === "NO" ? BigInt(payoutMilli) - BigInt(order.limitPriceMilli) : BigInt(order.limitPriceMilli);
}

function decimal(value: bigint): string {
  return `${value / 1_000n}.${(value % 1_000n).toString().padStart(3, "0")}`;
}

export function OrderAmendment({ order, payoutMilli, disabled = false, onEditingChange, onBusyChange, onComplete }: {
  order: AmendableOrder;
  payoutMilli: string;
  disabled?: boolean;
  onEditingChange?: (editing: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onComplete: (result: "saved" | "stale") => void | Promise<void>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const attempt = useRef<{ key: string; body: string; version: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [version, setVersion] = useState(order.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const maximumPrice = decimal(BigInt(payoutMilli) - 1n);

  function open() {
    setPrice(decimal(outcomeLimitPrice(order, payoutMilli)));
    setQuantity(String(order.remainingQuantity));
    setVersion(order.version);
    attempt.current = null;
    setError(null);
    setEditing(true);
    onEditingChange?.(true);
  }

  function close() {
    setEditing(false);
    onEditingChange?.(false);
    trigger.current?.focus();
  }

  function changed() {
    attempt.current = null;
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || disabled) return;
    // Only validate price/quantity here; actual fees and backing are determined by PATCH.
    const entry = parseOrderEntry(price, Number(quantity), BigInt(payoutMilli), 0, order.action);
    if (!entry.valid) { setError(entry.message); return; }
    pending.current = true;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    attempt.current ??= {
      key: crypto.randomUUID(),
      version,
      body: JSON.stringify({
        clientOrderId: crypto.randomUUID(),
        limitPriceMilli: entry.priceMilli.toString(),
        quantity: Number(quantity),
      }),
    };
    const currentAttempt = attempt.current;
    try {
      const response = await apiFetch(`/api/v1/orders/${encodeURIComponent(order.orderId)}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": currentAttempt.key,
          "If-Match": `order-version-${currentAttempt.version}`,
        },
        body: currentAttempt.body,
      });
      const body = await response.json().catch(() => null);
      if (response.status === 409) {
        attempt.current = null;
        close();
        await onComplete("stale");
        return;
      }
      if (response.status === 422) {
        // A confirmed rejection completed this command without replacing the
        // original. Retry unchanged inputs against current liquidity, not the
        // persisted rejection. Ambiguous transport/5xx attempts stay frozen.
        if (body?.accepted === false) attempt.current = null;
        const reason = body?.reason ?? body?.error?.message ?? "Replacement was rejected.";
        setError(`${reason} The original order was preserved.`);
        return;
      }
      if (!response.ok || body?.accepted !== true || !body?.order?.orderId || body?.replacedOrderId !== order.orderId) {
        throw new Error(body?.error?.message ?? "Replacement could not be confirmed. Retry to confirm the same request.");
      }
      attempt.current = null;
      close();
      await onComplete("saved");
    } catch (reason) {
      // A lost response can hide a committed replacement. Keep the exact payload and key.
      setError(reason instanceof Error ? reason.message : "Replacement could not be confirmed. Retry the same request.");
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  }

  return <div>
    <button ref={trigger} type="button" className="button button-secondary" disabled={disabled || busy} aria-expanded={editing} aria-controls={`${id}-form`} onClick={() => { if (editing) close(); else open(); }}>Edit remaining order</button>
    {editing && <form id={`${id}-form`} className="order-entry-form" aria-label={`Edit ${order.action} ${order.outcome} remaining order`} aria-describedby={`${id}-warning`} aria-busy={busy} onSubmit={submit}>
      <p id={`${id}-warning`} className="muted-copy">Replacement loses queue priority. Completed fills stay unchanged. Quantity below is the new unfilled order quantity.</p>
      <label className="field-label" htmlFor={`${id}-price`}>{order.outcome} limit price (feathers)</label>
      <input autoFocus id={`${id}-price`} name="amendPrice" type="number" min="0.001" max={maximumPrice} step="0.001" required value={price} disabled={busy || disabled} onChange={(event) => { setPrice(event.currentTarget.value); changed(); }} />
      <label className="field-label" htmlFor={`${id}-quantity`}>Remaining contracts</label>
      <input id={`${id}-quantity`} name="amendQuantity" type="number" min="1" max={ORDER_BOOK_LIMITS.maxQuantity} step="1" required value={quantity} disabled={busy || disabled} onChange={(event) => { setQuantity(event.currentTarget.value); changed(); }} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button type="submit" className="button button-primary" disabled={busy || disabled}>{busy ? "Saving replacement…" : "Save replacement"}</button>
      <button type="button" className="button button-ghost" disabled={busy} onClick={close}>Close editor</button>
    </form>}
  </div>;
}
