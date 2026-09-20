"use client";
import { FormEvent, useRef, useState } from "react";

function feathersToMilli(value: string): string | null {
  const match = /^(\d{1,9})(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const amount = BigInt(match[1]) * 1000n + BigInt((match[2] ?? "").padEnd(3, "0") || "0");
  return amount > 0n ? amount.toString() : null;
}

export function BalanceAdjustmentConsole() {
  const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const attempt = useRef<{ key: string; payload: string } | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null); setError(null); const form = event.currentTarget; const data = new FormData(form);
    const amountMilli = feathersToMilli(String(data.get("amount") ?? ""));
    if (!amountMilli) { setError("Enter a positive feather amount with at most three decimal places."); return; }
    const payload = JSON.stringify({ username: data.get("username"), amountMilli, reason: data.get("reason"), principalTreatment: data.get("principalTreatment") });
    if (attempt.current?.payload !== payload) attempt.current = { key: crypto.randomUUID(), payload };
    if (!window.confirm(`Debit ${String(data.get("amount"))} feathers from @${String(data.get("username"))}? This creates a permanent journal entry.`)) return;
    setBusy(true);
    try {
      const response = await fetch("/api/admin/balance-adjustments", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.current.key }, body: payload });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body?.error?.message ?? "The balance could not be adjusted."); return; }
      setMessage(`@${body.username} now has ${(BigInt(body.balanceMilli) / 1000n).toLocaleString()} feathers available. Journal ${body.journalId}.`); attempt.current = null; form.reset();
    } catch { setError("The request could not be completed. Retry to safely resume it."); } finally { setBusy(false); }
  }
  return <section className="moderation-panel"><div className="section-heading"><div><span className="eyebrow">Account operations</span><h2>Debit participant balance</h2></div><span>Audited</span></div><p>Debits available feathers only and creates a balanced, idempotent journal entry. It never liquidates positions or cancels orders.</p><form className="stacked-form" onSubmit={submit}><label>Username<input name="username" required minLength={3} maxLength={24} placeholder="bubbly" autoComplete="off" /></label><label>Feathers to subtract<input name="amount" required inputMode="decimal" placeholder="3000" /></label><label>Accounting treatment<select name="principalTreatment" defaultValue="REVERSE_GRANT"><option value="REVERSE_GRANT">Reverse a prior grant (preserve trading P/L)</option><option value="RECORD_LOSS">Administrative penalty (record as account loss)</option></select></label><label>Reason<textarea name="reason" required minLength={8} maxLength={500} placeholder="Why this debit is required" /></label><button className="button button-secondary" disabled={busy}>{busy ? "Applying…" : "Review and debit"}</button></form>{message && <p className="success-message" role="status">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}</section>;
}
