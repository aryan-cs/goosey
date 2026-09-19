"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client-api";
import { LoadingState } from "./states";

type Session = { id: string; userAgent: string | null; createdAt: string; expiresAt: string; current: boolean };
class SessionRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function readSessions(signal?: AbortSignal): Promise<Session[]> {
  const response = await fetch("/api/auth/sessions", { credentials: "same-origin", cache: "no-store", signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SessionRequestError(body?.error?.message ?? "Sessions could not be loaded.", response.status);
  if (!Array.isArray(body.items)) throw new Error("Sessions could not be read. Please refresh the list.");
  return body.items;
}

export function SessionManager() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const activeMutation = useRef<AbortController | null>(null);

  useEffect(() => () => {
    activeMutation.current?.abort();
    activeMutation.current = null;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    void readSessions(controller.signal).then((items) => {
      if (!controller.signal.aborted) { setSessions(items); setSignedOut(false); }
    }).catch((reason: unknown) => {
      if (disposed) return;
      if (controller.signal.aborted) { setError("Session loading timed out. Please refresh the list."); return; }
      if (reason instanceof SessionRequestError && reason.status === 401) { setSignedOut(true); setSessions([]); }
      else setError(reason instanceof Error ? reason.message : "Sessions could not be loaded.");
    }).finally(() => { window.clearTimeout(timeout); if (!disposed) setLoading(false); });
    return () => { disposed = true; window.clearTimeout(timeout); controller.abort(); };
  }, [revision]);

  function refresh() {
    if (pending.current || loading) return;
    setLoading(true); setError(null); setMessage(null);
    setRevision((value) => value + 1);
  }

  async function revoke(payload: { sessionId?: string; allOther?: boolean }) {
    if (pending.current || loading) return;
    pending.current = true;
    const controller = new AbortController();
    activeMutation.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    setBusy(payload.sessionId ?? "all"); setError(null); setMessage(null);
    try {
      const response = await apiFetch("/api/auth/sessions", { method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (activeMutation.current !== controller) return;
      controller.signal.throwIfAborted();
      if (response.status === 401) { setSignedOut(true); setSessions([]); return; }
      if (response.status === 404 && payload.sessionId) {
        // Recover when a successful response was lost or another browser
        // already revoked the session; never infer success from a network error.
        const items = await readSessions(controller.signal);
        if (activeMutation.current !== controller) return;
        controller.signal.throwIfAborted();
        setSessions(items);
        setMessage("List refreshed. That browser is already signed out.");
        return;
      }
      if (!response.ok) throw new Error(body?.error?.message ?? "Could not sign out that browser.");
      setSessions((current) => current.filter((session) => session.current || (!payload.allOther && session.id !== payload.sessionId)));
      setMessage(payload.allOther ? "Other browsers have been signed out. This browser stays signed in." : "That browser has been signed out.");
    } catch (reason) {
      if (activeMutation.current !== controller) return;
      if (controller.signal.aborted) { setError("Revocation timed out and could not be confirmed. Refresh the list before retrying."); return; }
      if (reason instanceof SessionRequestError && reason.status === 401) { setSignedOut(true); setSessions([]); }
      else setError(reason instanceof Error ? reason.message : "Revocation could not be confirmed. Retry or refresh the session list.");
    } finally {
      window.clearTimeout(timeout);
      if (activeMutation.current === controller) {
        activeMutation.current = null; pending.current = false; setBusy(null);
      }
    }
  }

  if (signedOut) return <p>Your session has ended. <Link href="/login?next=%2Fsettings%2Fsecurity">Sign in again</Link> to manage your browsers.</p>;
  return <div className="report-list" aria-busy={loading || busy !== null}>
    <div><button type="button" className="button button-ghost" disabled={loading || busy !== null} onClick={refresh}>Refresh browsers</button></div>
    {error && <p className="form-error" role="alert">{error} Use Refresh browsers to check the current list, or try signing out again.</p>}
    {message && <p className="success-message" role="status">{message}</p>}
    {loading && <LoadingState rows={2} label="Loading signed-in browsers" />}
    {!loading && !error && !sessions.length && <p>No active browsers were returned. Refresh to check your account.</p>}
    {sessions.map((session) => <article className="report-item" key={session.id}>
      <header><strong>{session.current ? "This browser" : "Signed-in browser"}</strong><span>expires {new Date(session.expiresAt).toLocaleDateString("en-CA", { dateStyle: "medium" })}</span></header>
      <p>{session.userAgent ?? "Unknown browser"}</p>
      <footer><span>Started {new Date(session.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</span>{!session.current && <button type="button" className="button button-ghost" disabled={loading || busy !== null} onClick={() => void revoke({ sessionId: session.id })}>{busy === session.id ? "Signing out…" : "Sign out"}</button>}</footer>
    </article>)}
    {sessions.some((session) => !session.current) && <button type="button" className="button button-secondary" disabled={loading || busy !== null} onClick={() => void revoke({ allOther: true })}>{busy === "all" ? "Signing out…" : "Sign out every other browser"}</button>}
  </div>;
}
