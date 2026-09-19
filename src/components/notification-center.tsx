"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { EmptyState, LoadingState } from "./states";
import { apiFetch } from "@/lib/client-api";

type NotificationItem = { id: string; type: string; title: string; body: string; href: string | null; readAt: string | null; createdAt: string };

export function NotificationCenter() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<"all" | string | null>(null);
  // The API returns only the most recent page; older unread items still count.
  const [unreadCount, setUnreadCount] = useState(0);
  async function load() {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/notifications", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "Notifications could not be loaded.");
      setItems(data.items ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Notifications could not be loaded."); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/notifications", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error?.message ?? "Notifications could not be loaded.");
        setItems(data.items ?? []);
        setUnreadCount(data.unreadCount ?? 0);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Notifications could not be loaded.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function markAll() {
    if (!unreadCount || busy) return;
    setStatus(null); setBusy("all");
    try {
      const response = await apiFetch("/api/notifications", { method: "PATCH", credentials: "same-origin" });
      if (response.ok) { setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() }))); setUnreadCount(0); setStatus("All caught up."); }
      else setStatus("Could not mark notifications as read. Try again.");
    } catch {
      setStatus("Could not mark notifications as read. Check your connection and try again.");
    } finally { setBusy(null); }
  }
  async function markOne(id: string) {
    const item = items.find((entry) => entry.id === id); if (!item || item.readAt || busy) return;
    setBusy(id); setStatus(null);
    try {
      const response = await apiFetch(`/api/notifications/${id}`, { method: "PATCH", credentials: "same-origin" });
      if (response.ok) {
        setItems((current) => current.map((entry) => entry.id === id ? { ...entry, readAt: new Date().toISOString() } : entry));
        setUnreadCount((current) => Math.max(0, current - 1));
      }
      else setStatus("Could not update that notification. Try again.");
    } catch {
      setStatus("Could not update that notification. Check your connection and try again.");
    } finally { setBusy(null); }
  }
  if (loading) return <LoadingState rows={5} label="Loading notifications" />;
  if (error) return <div className="error-state" role="alert"><Bell /><div><strong>Could not load updates</strong><p>{error}</p></div><button className="button button-secondary" onClick={() => void load()}>Retry</button></div>;
  if (!items.length) return <EmptyState title="You are all caught up" description="Trades, market results, and replies will appear here." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} />;
  return <section className="notification-panel" aria-busy={Boolean(busy)}><div className="section-heading"><h2>Recent updates</h2><button className="button button-secondary" disabled={!unreadCount || Boolean(busy)} onClick={() => void markAll()}><CheckCheck /> {unreadCount ? "Mark all read" : "All read"}</button></div>{status && <p className="status-message" role="status">{status}</p>}<div className="notification-list">{items.map((item) => <article className={item.readAt ? "notification-item" : "notification-item unread"} aria-label={`${item.title}, ${item.readAt ? "read" : "unread"}`} key={item.id}><span className="notification-icon"><Bell /></span><div><header><strong>{item.title}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</time></header><p>{item.body}</p>{item.href && <Link href={item.href} onClick={() => void markOne(item.id)}>View details</Link>}</div>{!item.readAt && <button className="notification-read" disabled={Boolean(busy)} onClick={() => void markOne(item.id)} aria-label={`Mark ${item.title} read`}><span /></button>}</article>)}</div></section>;
}
