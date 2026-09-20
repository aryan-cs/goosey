"use client";

import { FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type AdminMarket = { id: string; title: string; status: string; resolution: string | null; version: number };
type LifecycleAction = "pause" | "resume" | "close" | "resolve";
const lifecycleActions: Record<string, Array<{ value: LifecycleAction; label: string }>> = {
  DRAFT: [{ value: "close", label: "Close" }],
  OPEN: [{ value: "pause", label: "Pause" }, { value: "close", label: "Close" }, { value: "resolve", label: "Resolve expired market" }],
  PAUSED: [{ value: "resume", label: "Resume" }, { value: "close", label: "Close" }, { value: "resolve", label: "Resolve expired market" }],
  CLOSED: [{ value: "resolve", label: "Propose resolution" }],
};
const newKey = () => crypto.randomUUID();

async function mutation(url: string, body: unknown, idempotencyKey?: string) {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? "Admin request failed.");
  return data;
}

export function AdminConsole({ markets }: { markets: AdminMarket[] }) {
  const router = useRouter();
  const [pricingModel, setPricingModel] = useState<"LMSR" | "ORDER_BOOK">("ORDER_BOOK");
  const createAttempt = useRef<{ key: string; body: string } | null>(null);
  const proposalAttempt = useRef<{ key: string; body: string } | null>(null);
  const operationPending = useRef(false);
  const [marketUpdates, setMarketUpdates] = useState<Record<string, Pick<AdminMarket, "status" | "resolution" | "version">>>({});
  // Apply confirmed responses immediately; newer server snapshots always win.
  const currentMarkets = useMemo(() => markets.map((market) => {
    const update = marketUpdates[market.id];
    return update && update.version > market.version ? { ...market, ...update } : market;
  }), [markets, marketUpdates]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedMarketId, setSelectedMarketId] = useState(markets[0]?.id ?? "");
  const selectedMarket = useMemo(() => currentMarkets.find((market) => market.id === selectedMarketId), [currentMarkets, selectedMarketId]);
  const actions = selectedMarket ? lifecycleActions[selectedMarket.status] ?? [] : [];
  const [preferredAction, setAction] = useState<LifecycleAction>(actions[0]?.value ?? "close");
  const action = actions.find((item) => item.value === preferredAction)?.value ?? actions[0]?.value ?? "close";

  function selectMarket(marketId: string) {
    setSelectedMarketId(marketId);
    const market = currentMarkets.find((candidate) => candidate.id === marketId);
    setAction((market && lifecycleActions[market.status]?.[0]?.value) ?? "close");
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError(null); setMessage(null);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = Object.fromEntries(form.entries());
    try {
      payload.closesAt = new Date(String(payload.closesAt)).toISOString();
      payload.resolvesAt = new Date(String(payload.resolvesAt)).toISOString();
      const request = { ...payload, pricingModel, status: "OPEN", featured: false, liquidityParameter: Number(payload.liquidityParameter ?? 40), payoutMilli: "100000", feeBps: Number(payload.feeBps ?? 0) };
      const body = JSON.stringify(request);
      if (createAttempt.current?.body !== body) createAttempt.current = { key: newKey(), body };
      const result = await mutation("/api/admin/markets", request, createAttempt.current.key);
      setMessage(pricingModel === "ORDER_BOOK" ? "Order-book market created. It starts with no orders or price; participants supply the liquidity." : "Market-maker market created with its collateral subsidy and audit journal.");
      createAttempt.current = null;
      formElement.reset();
      setPricingModel("ORDER_BOOK");
      setSelectedMarketId(result.market.id);
      setAction("pause");
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function lifecycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operationPending.current || !actions.length) return;
    operationPending.current = true;
    setBusy(true); setError(null); setMessage(null);
    const form = new FormData(event.currentTarget); const marketId = String(form.get("marketId"));
    try {
      if (action === "resolve") {
        const request = { outcome: form.get("outcome"), reason: form.get("reason"), evidence: form.get("evidence") };
        const fingerprint = JSON.stringify({ marketId, ...request });
        if (proposalAttempt.current?.body !== fingerprint) proposalAttempt.current = { key: newKey(), body: fingerprint };
        await mutation(`/api/admin/markets/${marketId}/resolve`, request, proposalAttempt.current.key);
        proposalAttempt.current = null;
      }
      else {
        const selected = currentMarkets.find((market) => market.id === marketId);
        if (!selected) throw new Error("Select a valid market.");
        const result = await mutation(`/api/admin/markets/${marketId}/${action}`, { reason: form.get("reason"), expectedVersion: selected.version });
        const { status, resolution, version } = result.market;
        setMarketUpdates((current) => ({ ...current, [marketId]: { status, resolution, version } }));
      }
      setMessage(action === "resolve" ? "Resolution proposed. Confirm it below with your administrator password to pay all positions." : `Market ${action === "pause" ? "paused" : action === "resume" ? "reopened" : "closed"}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally {
      // Also recover authoritative state after a lost response or version conflict.
      router.refresh();
      operationPending.current = false;
      setBusy(false);
    }
  }
  return <div className="admin-grid">
    <section><h2>Create market</h2><form className="stacked-form" onSubmit={create}>
      <label>Trading model<select name="pricingModel" value={pricingModel} disabled={busy} onChange={(event) => setPricingModel(event.target.value as "LMSR" | "ORDER_BOOK")}><option value="ORDER_BOOK">Order book — participant limit orders</option><option value="LMSR">Market maker — treasury-funded liquidity</option></select></label>
      <p className="muted-copy">{pricingModel === "ORDER_BOOK" ? "Starts without a price or orders. Matching participant orders create fully backed contracts; no treasury subsidy is issued." : "Starts at 50% with automated quotes and a treasury-funded collateral subsidy."} The trading model cannot be changed after creation.</p>
      {pricingModel === "LMSR" && <label>Liquidity parameter<input name="liquidityParameter" type="number" min={1} max={1000000} step={1} defaultValue={40} required /></label>}
      <label>Fee (basis points; 100 = 1%)<input name="feeBps" type="number" min={0} max={1000} step={1} defaultValue={0} required /></label>
      <label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Question<input name="title" required minLength={10} /></label><label>Short title<input name="shortTitle" required minLength={3} /></label><label>Description<textarea name="description" required minLength={20} rows={3} /></label><label>Resolution rules<textarea name="rules" required minLength={20} rows={5} /></label><label>Resolution source<input name="resolutionSource" required minLength={3} /></label><label>Category<input name="category" required minLength={2} /></label><label>Color<select name="color" defaultValue="gold"><option>gold</option><option>green</option><option>blue</option><option>sky</option><option>orange</option><option>red</option><option>violet</option></select></label><label>Icon key<input name="icon" defaultValue="sparkles" required /></label><label>Closes at<input name="closesAt" type="datetime-local" required /></label><label>Resolves at<input name="resolvesAt" type="datetime-local" required /></label><button className="button button-primary" disabled={busy}>{pricingModel === "ORDER_BOOK" ? "Create order-book market" : "Create and fund market"}</button>
    </form></section>
    <section><h2>Market lifecycle</h2><form className="stacked-form" onSubmit={lifecycle}>
      <label>Market<select name="marketId" required disabled={busy} value={selectedMarketId} onChange={(event) => selectMarket(event.target.value)}>{currentMarkets.map((market) => <option key={market.id} value={market.id}>{market.status} · {market.title}</option>)}</select></label>
      <label>Action<select name="action" value={action} disabled={busy || !actions.length} onChange={(event) => setAction(event.target.value as LifecycleAction)}>{actions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      {action === "resolve" ? <>
        <label>Outcome for resolution<select name="outcome" defaultValue="YES" disabled={busy} required><option>YES</option><option>NO</option><option>VOID</option></select></label>
        <label>Evidence or source<input name="evidence" minLength={3} disabled={busy} required /></label>
      </> : null}
      <label>Reason<textarea name="reason" minLength={10} disabled={busy} required rows={4} /></label>
      <button className="button button-secondary" disabled={busy || !actions.length}>Apply lifecycle action</button>
      {selectedMarket && !actions.length ? <p className="muted-copy">No lifecycle actions are available for a {selectedMarket.status.toLowerCase()} market.</p> : null}
    </form></section>
    {(message || error) && <p className={error ? "form-error" : "success-message"} role="status">{error ?? message}</p>}
  </div>;
}
