"use client";

import { FormEvent, useRef, useState } from "react";

type Invite = { id: string; label: string; status: string; maxUses: number; useCount: number; expiresAt: string | Date | null };

export function InviteConsole({ initialInvites }: { initialInvites: Invite[] }) {
  const [invites, setInvites] = useState(initialInvites);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const issuanceAttemptRef = useRef<{ key: string; payload: string } | null>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null); setIssuedCode(null); setBusy(true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const expires = String(form.get("expiresAt") ?? "");
    const payload = JSON.stringify({ label: form.get("label"), maxUses: Number(form.get("maxUses")), expiresAt: expires ? new Date(expires).toISOString() : null });
    if (issuanceAttemptRef.current?.payload !== payload) issuanceAttemptRef.current = { key: crypto.randomUUID(), payload };
    try {
      const response = await fetch("/api/admin/invites", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": issuanceAttemptRef.current.key }, body: payload });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body?.error?.message ?? "Invitation could not be created."); return; }
      setInvites((current) => [body.invite, ...current.filter((invite) => invite.id !== body.invite.id)]);
      setIssuedCode(body.code);
      issuanceAttemptRef.current = null;
      formElement.reset();
    } catch {
      setError("Invitation could not be created. Retry to safely resume this request.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this invitation? Anyone holding the code will no longer be able to use it.")) return;
    setError(null); setRevokingId(id);
    try {
      const response = await fetch(`/api/admin/invites/${id}`, { method: "DELETE", credentials: "same-origin" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setError(body?.error?.message ?? "Invitation could not be revoked."); return; }
      setInvites((current) => current.map((invite) => invite.id === id ? { ...invite, status: body.invite.status } : invite));
    } catch {
      setError("Invitation could not be revoked.");
    } finally {
      setRevokingId(null);
    }
  }

  return <section className="moderation-panel"><div className="section-heading"><div><span className="eyebrow">Invite codes</span><h2>Registration invites</h2></div><span>{invites.filter((invite) => invite.status === "ACTIVE" && invite.useCount < invite.maxUses).length} active</span></div><form className="stacked-form" onSubmit={create}><label>Label<input name="label" minLength={2} maxLength={80} required placeholder="Hacker check-in · table 4" /></label><label>Number of signups<input name="maxUses" type="number" min={1} max={10} defaultValue={1} required /></label><label>Expires at (optional)<input name="expiresAt" type="datetime-local" /></label><button className="button button-secondary" disabled={busy}>{busy ? "Creating…" : "Create invite"}</button></form>{issuedCode && <div className="success-message" role="status"><strong>Copy this code now. It is shown once:</strong> <code>{issuedCode}</code></div>}{error && <p className="form-error" role="alert">{error}</p>}<div className="report-list">{invites.slice(0, 20).map((invite) => <article className="report-item" key={invite.id}><header><strong>{invite.label}</strong><span>{invite.status}</span></header><p>{invite.useCount} of {invite.maxUses} claimed{invite.expiresAt ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}` : ""}</p>{invite.status === "ACTIVE" && invite.useCount < invite.maxUses ? <footer><button type="button" className="button button-ghost" disabled={revokingId === invite.id} onClick={() => void revoke(invite.id)}>{revokingId === invite.id ? "Revoking…" : "Revoke"}</button></footer> : null}</article>)}</div></section>;
}
