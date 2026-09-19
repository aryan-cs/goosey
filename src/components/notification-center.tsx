"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";
import { EmptyState, LoadingState } from "./states";
import { apiFetch } from "@/lib/client-api";
import {
  EMPTY_NOTIFICATION_FEED,
  isNotificationFeedPage,
  mergeNotificationFeed,
  type NotificationFeed,
  type NotificationFeedPage,
} from "@/lib/notification-feed";
import { startVisiblePolling } from "@/lib/visible-polling";
import styles from "./notification-center.module.css";

export function NotificationCenter() {
  const router = useRouter();
  const [feed, setFeed] = useState<NotificationFeed>(EMPTY_NOTIFICATION_FEED);
  const current = useRef<NotificationFeed>(EMPTY_NOTIFICATION_FEED);
  const pending = useRef(false);
  const mounted = useRef(false);
  const activeRead = useRef<AbortController | null>(null);
  const activeMutation = useRef<AbortController | null>(null);
  const lastUnread = useRef<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [initialFinished, setInitialFinished] = useState(false);

  const commit = useCallback((next: NotificationFeed) => {
    if (!mounted.current) return;
    current.current = next;
    setFeed(next);
    if (lastUnread.current !== null && lastUnread.current !== next.unreadCount) router.refresh();
    lastUnread.current = next.unreadCount;
  }, [router]);

  const clearSession = useCallback(() => {
    commit({ ...EMPTY_NOTIFICATION_FEED, initialized: true, signedOut: true });
    setError(null);
    setStatus(null);
    setInitialFinished(true);
  }, [commit]);

  const interruptRead = useCallback(() => {
    activeRead.current?.abort();
    activeRead.current = null;
  }, []);

  const read = useCallback(async (mode: "poll" | "replace" | "more", signal?: AbortSignal, cursor?: string) => {
    if (signal?.aborted || (mode === "poll" && (pending.current || current.current.signedOut || document.visibilityState === "hidden"))) return;
    interruptRead();
    const controller = new AbortController();
    activeRead.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = window.setTimeout(abort, 10_000);
    const valid = () => mounted.current && !controller.signal.aborted && activeRead.current === controller;
    async function fetchPage(after?: string): Promise<NotificationFeedPage | null> {
      const response = await fetch(`/api/notifications${after ? `?cursor=${encodeURIComponent(after)}` : ""}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (!valid()) return null;
      if (response.status === 401) { clearSession(); return null; }
      const data = await response.json().catch(() => null);
      if (!valid()) return null;
      if (!response.ok) throw new Error(data?.error?.message ?? "Notifications could not be loaded.");
      if (!isNotificationFeedPage(data)) throw new Error("Notification updates could not be read. Please retry.");
      return data;
    }
    try {
      let page = await fetchPage(cursor);
      if (!page || !valid()) return;
      let merged = mergeNotificationFeed(current.current, page, mode);
      if (merged.reloadHead) {
        // A tail page under new preferences cannot be appended to the old list.
        // Invalidate known-obsolete rows even if the following head request fails.
        commit(merged.feed);
        page = await fetchPage();
        if (!page || !valid()) return;
        merged = mergeNotificationFeed(current.current, page, "replace");
      }
      commit(merged.feed);
      setError(null);
    } catch (reason) {
      if (!mounted.current || activeRead.current !== controller || signal?.aborted) return;
      setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Updates timed out. Please retry.");
      throw reason;
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (mounted.current && activeRead.current === controller) {
        if (!controller.signal.aborted) setInitialFinished(true);
        activeRead.current = null;
      }
    }
  }, [interruptRead, clearSession, commit]);

  useEffect(() => {
    mounted.current = true;
    const stop = startVisiblePolling({
      run: (signal) => read("poll", signal),
      intervalMs: 10_000,
      isPaused: () => pending.current || current.current.signedOut,
      onError: () => {
        if (!mounted.current || pending.current || current.current.signedOut) return;
        setInitialFinished(true);
        setError("Updates interrupted. Refresh to retry; existing notifications are preserved.");
      },
    });
    const visibility = () => {
      if (document.visibilityState === "hidden" && !pending.current) interruptRead();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      mounted.current = false;
      stop();
      interruptRead();
      activeMutation.current?.abort();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [read, interruptRead]);

  async function refresh(mode: "replace" | "more") {
    if (pending.current || (mode === "more" && !current.current.nextCursor)) return;
    pending.current = true;
    interruptRead();
    setBusy(mode);
    setError(null);
    setStatus(null);
    try {
      await read(mode, undefined, mode === "more" ? current.current.nextCursor! : undefined);
    } catch { /* read preserves existing rows and exposes the retry notice */ }
    finally {
      pending.current = false;
      if (mounted.current) { setBusy(null); setInitialFinished(true); }
    }
  }

  async function mark(id?: string, navigating = false) {
    if (pending.current || current.current.signedOut) return;
    if (id ? !current.current.items.some((item) => item.id === id && !item.readAt) : !current.current.unreadCount) return;
    pending.current = true;
    interruptRead();
    const controller = new AbortController();
    // Navigation reads may finish after this component unmounts. The timeout
    // still bounds them, but cleanup must not abort the keepalive request.
    if (!navigating) activeMutation.current = controller;
    setBusy(id ?? "all");
    setStatus(null);
    setError(null);
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await apiFetch(id ? `/api/notifications/${encodeURIComponent(id)}` : "/api/notifications", {
        method: "PATCH", credentials: "same-origin", signal: controller.signal, keepalive: navigating,
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (response.status === 401) { clearSession(); return; }
      if (!response.ok) throw new Error("Could not mark notifications as read. Please retry.");
      setStatus("Read status saved.");
      // Arrivals during PATCH remain unread: only GET supplies the new count.
      await read("replace");
    } catch (reason) {
      if (mounted.current && (navigating || activeMutation.current === controller)) setError(reason instanceof Error && reason.name !== "AbortError" ? reason.message : "Read status could not be confirmed. Refresh to check.");
    } finally {
      window.clearTimeout(timer);
      if (activeMutation.current === controller) activeMutation.current = null;
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  return <section className="notification-panel" aria-busy={Boolean(busy)}>
    <div className={styles.header}><h2>Recent updates</h2>
      <div className={styles.actions}>
      <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void refresh("replace")}>{busy === "replace" ? "Refreshing…" : "Refresh updates"}</button>
      {!feed.signedOut && <button type="button" className="button button-secondary" disabled={!feed.unreadCount || Boolean(busy)} onClick={() => void mark()}><CheckCheck /> {feed.unreadCount ? "Mark all read" : "All read"}</button>}
      </div>
    </div>
    {error && <p className="form-error" role="alert">{error} <button type="button" className="button button-ghost" disabled={Boolean(busy)} onClick={() => void refresh("replace")}>Retry refresh</button></p>}
    {status && <p className="status-message" role="status">{status}</p>}
    {feed.newUpdates && <p className="status-message" role="status">Notification updates are available. Refresh to show new notifications or read-status changes.</p>}
    {feed.signedOut ? <EmptyState title="Sign in to see notifications" description="Your session has ended." action={<Link className="button button-primary" href="/login?next=%2Fnotifications">Sign in</Link>} />
      : !initialFinished && !feed.initialized ? <LoadingState rows={5} label="Loading notifications" />
      : !feed.items.length && !error ? <EmptyState title="You are all caught up" description="Trades, market results, and replies will appear here." action={<Link className="button button-primary" href="/markets">Browse markets</Link>} />
      : <div className="notification-list">{feed.items.map((item) => <article className={item.readAt ? "notification-item" : "notification-item unread"} aria-label={`${item.title}, ${item.readAt ? "read" : "unread"}`} key={item.id}>
        <span className="notification-icon"><Bell /></span><div><header><strong>{item.title}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}</time></header><p>{item.body}</p>{item.href && <Link href={item.href} onClick={() => void mark(item.id, true)}>View details</Link>}</div>
        {!item.readAt && <button type="button" className="notification-read" disabled={Boolean(busy)} onClick={() => void mark(item.id)} aria-label={`Mark ${item.title} read`}><span /></button>}
      </article>)}</div>}
    {!feed.signedOut && feed.nextCursor && <button type="button" className="button button-secondary" disabled={Boolean(busy)} onClick={() => void refresh("more")}>{busy === "more" ? "Loading older notifications…" : "Load older notifications"}</button>}
  </section>;
}
