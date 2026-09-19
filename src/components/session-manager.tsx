"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client-api";

type Session = { id: string; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean };

export function SessionManager() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/auth/sessions", { credentials: "same-origin" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body?.error?.message ?? "Sessions could not be loaded."); setSessions(body.items); }).catch((reason) => setError(reason instanceof Error ? reason.message : "Sessions could not be loaded.")); }, []);
  async function revoke(payload: { sessionId?: string; allOther?: boolean }) {
    const response = await apiFetch("/api/auth/sessions", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body?.error?.message ?? "Session could not be revoked."); return; }
    setSessions((current) => current.filter((session) => session.current || (!payload.allOther && session.id !== payload.sessionId)));
  }
  return <div className="report-list">{error && <p className="form-error">{error}</p>}{sessions.map((session) => <article className="report-item" key={session.id}><header><strong>{session.current ? "This browser" : "Signed-in browser"}</strong><span>expires {new Date(session.expiresAt).toLocaleDateString("en-CA", { dateStyle: "medium" })}</span></header><p>{session.userAgent ?? "Unknown browser"}</p><footer><span>Started {new Date(session.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span>{!session.current && <button className="button button-ghost" onClick={() => void revoke({ sessionId: session.id })}>Revoke</button>}</footer></article>)}{sessions.some((session) => !session.current) && <button className="button button-secondary" onClick={() => void revoke({ allOther: true })}>Sign out every other browser</button>}</div>;
}
