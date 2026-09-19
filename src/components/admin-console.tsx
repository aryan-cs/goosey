"use client";

import { FormEvent, useMemo, useState } from "react";

type AdminMarket = { id: string; title: string; status: string; resolution: string | null; version: number };
type LifecycleAction = "pause" | "resume" | "close" | "resolve";
const lifecycleActions: Record<string, Array<{ value: LifecycleAction; label: string }>> = {
  DRAFT: [{ value: "close", label: "Close" }],
  OPEN: [{ value: "pause", label: "Pause" }, { value: "close", label: "Close" }],
  PAUSED: [{ value: "resume", label: "Resume" }, { value: "close", label: "Close" }],
  CLOSED: [{ value: "resolve", label: "Propose resolution" }],
};
const newKey = () => crypto.randomUUID();

async function mutation(url: string, body: unknown, idempotent = false) {
  const response = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", ...(idempotent ? { "Idempotency-Key": newKey() } : {}) }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? "Admin request failed.");
  return data;
}

export function AdminConsole({ markets }: { markets: AdminMarket[] }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedMarketId, setSelectedMarketId] = useState(markets[0]?.id ?? "");
  const selectedMarket = useMemo(() => markets.find((market) => market.id === selectedMarketId), [markets, selectedMarketId]);
  const actions = selectedMarket ? lifecycleActions[selectedMarket.status] ?? [] : [];
  const [action, setAction] = useState<LifecycleAction>(actions[0]?.value ?? "close");

  function selectMarket(marketId: string) {
    setSelectedMarketId(marketId);
    const market = markets.find((candidate) => candidate.id === marketId);
    setAction((market && lifecycleActions[market.status]?.[0]?.value) ?? "close");
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    payload.closesAt = new Date(String(payload.closesAt)).toISOString();
    payload.resolvesAt = new Date(String(payload.resolvesAt)).toISOString();
    try {
      await mutation("/api/admin/markets", { ...payload, status: "OPEN", featured: false, liquidityParameter: 40, payoutMilli: "100000", feeBps: 0 }, true);
      setMessage("Market created with its collateral subsidy and audit journal."); event.currentTarget.reset();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  }
  async function lifecycle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null);
    const form = new FormData(event.currentTarget); const marketId = String(form.get("marketId"));
    try {
      if (action === "resolve") await mutation(`/api/admin/markets/${marketId}/resolve`, { outcome: form.get("outcome"), reason: form.get("reason"), evidence: form.get("evidence") }, true);
      else {
        const selected = markets.find((market) => market.id === marketId);
        if (!selected) throw new Error("Select a valid market.");
        await mutation(`/api/admin/markets/${marketId}/${action}`, { reason: form.get("reason"), expectedVersion: selected.version });
      }
      setMessage(action === "resolve" ? "Resolution proposed. A different eligible administrator must approve it before settlement." : `Market ${action} request completed. Reload to see the authoritative state.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Request failed."); }
    finally { setBusy(false); }
  }
  return <div className="admin-grid">
    <section><h2>Create market</h2><form className="stacked-form" onSubmit={create}>
      <label>Slug<input name="slug" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" /></label><label>Question<input name="title" required minLength={10} /></label><label>Short title<input name="shortTitle" required minLength={3} /></label><label>Description<textarea name="description" required minLength={20} rows={3} /></label><label>Resolution rules<textarea name="rules" required minLength={20} rows={5} /></label><label>Resolution source<input name="resolutionSource" required minLength={3} /></label><label>Category<input name="category" required minLength={2} /></label><label>Color<select name="color" defaultValue="gold"><option>gold</option><option>green</option><option>blue</option><option>sky</option><option>orange</option><option>red</option><option>violet</option></select></label><label>Icon key<input name="icon" defaultValue="sparkles" required /></label><label>Closes at<input name="closesAt" type="datetime-local" required /></label><label>Resolves at<input name="resolvesAt" type="datetime-local" required /></label><button className="button button-primary" disabled={busy}>Create and fund</button>
    </form></section>
    <section><h2>Market lifecycle</h2><form className="stacked-form" onSubmit={lifecycle}><label>Market<select name="marketId" required value={selectedMarketId} onChange={(event) => selectMarket(event.target.value)}>{markets.map((market) => <option key={market.id} value={market.id}>{market.status} · {market.title}</option>)}</select></label><label>Action<select name="action" value={action} disabled={!actions.length} onChange={(event) => setAction(event.target.value as LifecycleAction)}>{actions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>{action === "resolve" ? <><label>Outcome for resolution<select name="outcome" defaultValue="YES" required><option>YES</option><option>NO</option><option>VOID</option></select></label><label>Evidence or source<input name="evidence" minLength={3} required /></label></> : null}<label>Reason<textarea name="reason" minLength={10} required rows={4} /></label><button className="button button-secondary" disabled={busy || !actions.length}>Apply lifecycle action</button>{selectedMarket && !actions.length ? <p className="muted-copy">No lifecycle actions are available for a {selectedMarket.status.toLowerCase()} market.</p> : null}</form></section>
    {(message || error) && <p className={error ? "form-error" : "success-message"} role="status">{error ?? message}</p>}
  </div>;
}
