"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, Flag, LoaderCircle, MessageCircle, Pencil, Reply, Send, Shield, Trash2, X } from "lucide-react";
import { EmptyState, LoadingState } from "./states";
import { apiFetch } from "@/lib/client-api";

export interface CommentAuthor { id: string; displayName: string; avatarUrl?: string | null; badge?: string | null }
export interface MarketComment { id: string; body: string; createdAt: string; editedAt?: string | null; author: CommentAuthor; replyCount?: number; status?: string; replies?: MarketComment[] }
export interface CommentSectionProps { marketId: string; currentUserId?: string; csrfToken?: string; endpoint?: string; maxLength?: number }

function key() { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function initials(name: string) { return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function normalizeComment(value: unknown): MarketComment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.body !== "string" || typeof item.createdAt !== "string") return null;
  const rawAuthor = (item.author ?? item.user) as Record<string, unknown> | undefined;
  const displayName = typeof rawAuthor?.displayName === "string" ? rawAuthor.displayName : typeof rawAuthor?.username === "string" ? rawAuthor.username : "Goosey member";
  const replies = Array.isArray(item.replies) ? item.replies.map(normalizeComment).filter((reply): reply is MarketComment => Boolean(reply)) : [];
  return { id: item.id, body: item.body, createdAt: item.createdAt, editedAt: typeof item.editedAt === "string" ? item.editedAt : null, status: typeof item.status === "string" ? item.status : undefined, replyCount: typeof item.replyCount === "number" ? item.replyCount : replies.length, replies, author: { id: typeof rawAuthor?.id === "string" ? rawAuthor.id : typeof rawAuthor?.username === "string" ? rawAuthor.username : item.id, displayName, badge: typeof rawAuthor?.badge === "string" ? rawAuthor.badge : null } };
}

export function CommentSection({ marketId, currentUserId, csrfToken, endpoint, maxLength = 800 }: CommentSectionProps) {
  const base = endpoint ?? `/api/markets/${encodeURIComponent(marketId)}/comments`;
  const [comments, setComments] = useState<MarketComment[]>([]);
  const [body, setBody] = useState("");
  const [sort, setSort] = useState<"top" | "newest">("top");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [canPost, setCanPost] = useState<boolean | null>(currentUserId ? true : null);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<MarketComment | null>(null);
  const [reporting, setReporting] = useState<MarketComment | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarketComment | null>(null);
  const [editBody, setEditBody] = useState("");
  const [reload, setReload] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const pendingKey = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${base}?sort=${sort}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error?.message ?? "Comments could not be loaded.");
        const values: unknown[] = Array.isArray(data) ? data : data.comments ?? data.items ?? [];
        setComments(values.map(normalizeComment).filter((item): item is MarketComment => Boolean(item)));
        setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Comments could not be loaded.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [base, reload, sort]);

  useEffect(() => {
    if (currentUserId) return;
    const controller = new AbortController();
    void fetch("/api/auth/session", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => { if (!controller.signal.aborted) setCanPost(Boolean(data?.user)); })
      .catch(() => { if (!controller.signal.aborted) setCanPost(false); });
    return () => controller.abort();
  }, [currentUserId]);

  function retryLoad() {
    setLoading(true);
    setError(null);
    setReload((value) => value + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const clean = body.trim();
    if (!clean || clean.length > maxLength) return;
    setSending(true); setError(null); pendingKey.current ??= key();
    try {
      const response = await apiFetch(base, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": pendingKey.current, ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, body: JSON.stringify({ body: clean, parentId: replyTo?.id ?? null }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "Your comment could not be posted.");
      const created = normalizeComment(data.comment ?? data);
      if (!created) throw new Error("The server did not return the posted comment.");
      setComments((current) => replyTo ? current.map((comment) => comment.id === replyTo.id ? { ...comment, replies: [...(comment.replies ?? []), created], replyCount: (comment.replyCount ?? 0) + 1 } : comment) : [created, ...current.filter((comment) => comment.id !== created.id)]); setBody(""); setReplyTo(null); pendingKey.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Your comment could not be posted."); }
    finally { setSending(false); }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${base}?cursor=${encodeURIComponent(nextCursor)}&sort=${sort}`, { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "More comments could not be loaded.");
      const values: unknown[] = data.items ?? [];
      const incoming = values.map(normalizeComment).filter((item): item is MarketComment => Boolean(item));
      setComments((current) => [...current, ...incoming]); setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "More comments could not be loaded."); }
    finally { setLoading(false); }
  }

  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!reporting) return; const form = new FormData(event.currentTarget); setReportMessage(null);
    try {
      const response = await apiFetch(`/api/comments/${reporting.id}/report`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: form.get("reason"), details: form.get("details") }) });
      const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data?.error?.message ?? "Report could not be sent."); setReporting(null); setReportMessage("Report sent to the moderation queue.");
    } catch (reason) { setReportMessage(reason instanceof Error ? reason.message : "Report could not be sent."); }
  }

  function replaceComment(id: string, replacement: (comment: MarketComment) => MarketComment) {
    setComments((current) => current.map((comment) => comment.id === id ? replacement(comment) : { ...comment, replies: comment.replies?.map((reply) => reply.id === id ? replacement(reply) : reply) }));
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing || !editBody.trim()) return;
    const response = await apiFetch(`/api/comments/${editing.id}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: editBody.trim() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data?.error?.message ?? "Comment could not be edited."); return; }
    const updated = normalizeComment(data.comment);
    if (updated) replaceComment(editing.id, () => updated);
    setEditing(null); setEditBody("");
  }

  async function remove(comment: MarketComment) {
    if (!window.confirm("Delete this comment? Replies will remain visible.")) return;
    const response = await apiFetch(`/api/comments/${comment.id}`, { method: "DELETE", credentials: "same-origin" });
    if (!response.ok) { const data = await response.json().catch(() => ({})); setError(data?.error?.message ?? "Comment could not be deleted."); return; }
    replaceComment(comment.id, (item) => ({ ...item, body: "[deleted]", status: "DELETED" }));
  }

  return (
    <section className="comments-section" aria-labelledby="discussion-heading">
      <div className="section-heading"><div><span className="eyebrow">Community</span><h2 id="discussion-heading">Discussion</h2></div><span className="comment-count"><MessageCircle /> {comments.length}</span></div>
      <form className="comment-composer" onSubmit={submit}>
        <label htmlFor="comment-body">Add a comment</label>
        {replyTo && <div className="replying-to"><span>Replying to {replyTo.author.displayName}</span><button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X /></button></div>}
        <textarea id="comment-body" value={body} maxLength={maxLength} rows={3} disabled={!canPost || sending} onChange={(event) => { setBody(event.target.value); pendingKey.current = null; }} placeholder={canPost === null ? "Checking your account..." : canPost ? replyTo ? "Write a reply" : "What do you think, and why?" : "Sign in to join the discussion"} />
        {canPost === false && <p className="signed-out-guidance"><Link href="/login">Sign in</Link> to comment, reply, or report a problem.</p>}
        <div><span className={body.length > maxLength * .9 ? "near-limit" : ""}>{body.length}/{maxLength}</span><button className="button button-primary" disabled={!canPost || !body.trim() || sending}>{sending ? <LoaderCircle className="spin" /> : <Send />} Post</button></div>
      </form>
      {reporting && <form className="report-form" onSubmit={report}><div><strong>Report comment by {reporting.author.displayName}</strong><button type="button" onClick={() => setReporting(null)} aria-label="Cancel report"><X /></button></div><label>Reason<select name="reason" defaultValue="HARASSMENT"><option value="HARASSMENT">Harassment</option><option value="PRIVATE_INFORMATION">Private information</option><option value="SPAM">Spam</option><option value="MANIPULATION">Market manipulation</option><option value="OTHER">Other</option></select></label><label>Details<textarea name="details" maxLength={500} rows={3} /></label><button className="button button-secondary">Send report</button></form>}
      {editing && <form className="report-form" onSubmit={saveEdit}><div><strong>Edit your comment</strong><button type="button" onClick={() => setEditing(null)} aria-label="Cancel edit"><X /></button></div><label>Comment<textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={maxLength} rows={4} required /></label><button className="button button-secondary">Save edit</button></form>}
      {reportMessage && <p className="status-message" role="status">{reportMessage}</p>}
      {error && <p className="form-error" role="alert"><AlertCircle /> {error} <button onClick={retryLoad}>Retry</button></p>}
      <div className="comment-toolbar"><div className="segmented compact" role="group" aria-label="Sort comments"><button type="button" aria-pressed={sort === "top"} className={sort === "top" ? "active" : ""} onClick={() => { setLoading(true); setError(null); setSort("top"); }}>Most replies</button><button type="button" aria-pressed={sort === "newest"} className={sort === "newest" ? "active" : ""} onClick={() => { setLoading(true); setError(null); setSort("newest"); }}>Newest</button></div><p><Shield /> Keep it friendly and back up your take.</p></div>
      {loading ? <LoadingState rows={3} label="Loading comments" /> : comments.length === 0 ? <EmptyState title="No comments yet" description="Share what you think and why." /> : (
        <><div className="comment-list">{[...comments].sort((a, b) => sort === "top" ? (b.replyCount ?? 0) - (a.replyCount ?? 0) : Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((comment) => <article className="comment" key={comment.id}><div className="comment-avatar" aria-hidden="true">{initials(comment.author.displayName)}</div><div className="comment-content"><header><strong>{comment.author.displayName}</strong>{comment.author.badge && <span className="author-badge">{comment.author.badge}</span>}<time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></header><p>{comment.status === "DELETED" ? <em>This comment was deleted.</em> : comment.body}</p>{comment.status !== "DELETED" && <footer><button type="button" onClick={() => { setReplyTo(comment); setBody(""); document.getElementById("comment-body")?.focus(); }}><Reply /> Reply</button>{currentUserId === comment.author.id ? <><button type="button" onClick={() => { setEditing(comment); setEditBody(comment.body); }}><Pencil /> Edit</button><button type="button" onClick={() => void remove(comment)}><Trash2 /> Delete</button></> : currentUserId && <button type="button" onClick={() => setReporting(comment)}><Flag /> Report</button>}</footer>}{comment.replies?.length ? <div className="comment-replies">{comment.replies.map((reply) => <article className="comment reply-comment" key={reply.id}><div className="comment-avatar" aria-hidden="true">{initials(reply.author.displayName)}</div><div className="comment-content"><header><strong>{reply.author.displayName}</strong><time dateTime={reply.createdAt}>{new Date(reply.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></header><p>{reply.status === "DELETED" ? <em>This reply was deleted.</em> : reply.body}</p>{reply.status !== "DELETED" && currentUserId && <footer>{currentUserId === reply.author.id ? <><button type="button" onClick={() => { setEditing(reply); setEditBody(reply.body); }}><Pencil /> Edit</button><button type="button" onClick={() => void remove(reply)}><Trash2 /> Delete</button></> : <button type="button" onClick={() => setReporting(reply)}><Flag /> Report</button>}</footer>}</div></article>)}</div> : null}</div></article>)}</div>{nextCursor && <button className="button button-secondary load-more" onClick={() => void loadMore()} disabled={loading}>Load more discussion</button>}</>
      )}
    </section>
  );
}
