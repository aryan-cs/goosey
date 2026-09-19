"use client";

import { initials } from "@/lib/initials";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, Flag, MessageCircle, Pencil, Reply, Trash2, X } from "lucide-react";
import { EmptyState, LoadingState } from "./states";
import { apiFetch } from "@/lib/client-api";
import styles from "./comments.module.css";

export interface CommentAuthor { id: string; displayName: string; avatarUrl?: string | null; badge?: string | null }
export interface MarketComment { id: string; body: string; createdAt: string; editedAt?: string | null; author: CommentAuthor; replyCount?: number; status?: string; replies?: MarketComment[]; repliesNextCursor?: string | null }
export interface CommentSectionProps { marketId: string; marketSlug: string; focusedCommentId?: string; currentUserId?: string; csrfToken?: string; endpoint?: string; maxLength?: number }

function key() { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function normalizeComment(value: unknown): MarketComment | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.body !== "string" || typeof item.createdAt !== "string") return null;
  const rawAuthor = (item.author ?? item.user) as Record<string, unknown> | undefined;
  const displayName = typeof rawAuthor?.displayName === "string" ? rawAuthor.displayName : typeof rawAuthor?.username === "string" ? rawAuthor.username : "Goosey member";
  const replies = Array.isArray(item.replies) ? item.replies.map(normalizeComment).filter((reply): reply is MarketComment => Boolean(reply)) : [];
  return { id: item.id, body: item.body, createdAt: item.createdAt, editedAt: typeof item.editedAt === "string" ? item.editedAt : null, status: typeof item.status === "string" ? item.status : undefined, replyCount: typeof item.replyCount === "number" ? item.replyCount : replies.length, replies, repliesNextCursor: typeof item.repliesNextCursor === "string" ? item.repliesNextCursor : null, author: { id: typeof rawAuthor?.id === "string" ? rawAuthor.id : typeof rawAuthor?.username === "string" ? rawAuthor.username : item.id, displayName, badge: typeof rawAuthor?.badge === "string" ? rawAuthor.badge : null } };
}

export function CommentSection(props: CommentSectionProps) {
  // A different linked discussion is a new list and composer context.
  return <CommentSectionContent key={JSON.stringify([props.marketId, props.endpoint, props.focusedCommentId])} {...props} />;
}

function CommentSectionContent({ marketId, marketSlug, focusedCommentId, currentUserId, csrfToken, endpoint, maxLength = 800 }: CommentSectionProps) {
  const base = endpoint ?? `/api/markets/${encodeURIComponent(marketId)}/comments`;
  const marketHref = `/markets/${encodeURIComponent(marketSlug)}`;
  const returnHref = `${marketHref}${focusedCommentId ? `?comment=${encodeURIComponent(focusedCommentId)}` : ""}#discussion-heading`;
  const [comments, setComments] = useState<MarketComment[]>([]);
  const [body, setBody] = useState("");
  const [sort, setSort] = useState<"top" | "newest">("top");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [canPost, setCanPost] = useState<boolean | null>(currentUserId ? true : null);
  const [error, setError] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ comment: MarketComment; rootId: string } | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const replyInput = useRef<HTMLTextAreaElement>(null);
  const [reporting, setReporting] = useState<MarketComment | null>(null);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<MarketComment | null>(null);
  const [editBody, setEditBody] = useState("");
  const [reload, setReload] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const pendingKey = useRef<{ key: string; payload: string } | null>(null);
  const posting = useRef(false);
  const listGeneration = useRef(0);
  const loadingMore = useRef(false);
  const repliesInFlight = useRef(new Set<string>());
  const [loadingReplies, setLoadingReplies] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++listGeneration.current;
    const query = new URLSearchParams(focusedCommentId ? { comment: focusedCommentId } : { sort });
    void fetch(`${base}?${query}`, { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error?.message ?? "Comments could not be loaded.");
        if (controller.signal.aborted || generation !== listGeneration.current) return;
        const values: unknown[] = Array.isArray(data) ? data : data.comments ?? data.items ?? [];
        setComments(values.map(normalizeComment).filter((item): item is MarketComment => Boolean(item)));
        setNextCursor(!focusedCommentId && typeof data.nextCursor === "string" ? data.nextCursor : null);
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted || generation !== listGeneration.current) return;
        setError(reason instanceof Error ? reason.message : "Comments could not be loaded.");
      })
      .finally(() => { if (!controller.signal.aborted && generation === listGeneration.current) setLoading(false); });
    return () => { controller.abort(); listGeneration.current += 1; };
  }, [base, reload, sort, focusedCommentId]);

  useEffect(() => {
    if (currentUserId) return;
    const controller = new AbortController();
    void fetch("/api/auth/session", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((data) => { if (!controller.signal.aborted) setCanPost(Boolean(data?.user)); })
      .catch(() => { if (!controller.signal.aborted) setCanPost(false); });
    return () => controller.abort();
  }, [currentUserId]);

  useEffect(() => { replyInput.current?.focus(); }, [replyTo]);

  function retryLoad() {
    setLoading(true);
    setError(null);
    setReload((value) => value + 1);
  }

  async function submit(event: FormEvent, isReply = false) {
    event.preventDefault();
    const clean = (isReply ? replyBody : body).trim();
    if (posting.current || !clean || clean.length > maxLength) return;
    posting.current = true;
    const parentId = isReply ? replyTo?.comment.id ?? null : null;
    const rootId = isReply ? replyTo?.rootId : null;
    const payload = JSON.stringify({ body: clean, parentId });
    if (pendingKey.current?.payload !== payload) pendingKey.current = { key: key(), payload };
    setSending(true); setError(null); setReplyError(null);
    try {
      const response = await apiFetch(base, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": pendingKey.current.key, ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, body: payload });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "Your comment could not be posted.");
      const created = normalizeComment(data.comment ?? data);
      if (!created) throw new Error("The server did not return the posted comment.");
      setComments((current) => parentId ? current.map((comment) => comment.id === rootId ? { ...comment, replies: [...(comment.replies ?? []).filter((reply) => reply.id !== created.id), created], replyCount: (comment.replyCount ?? 0) + (comment.replies?.some((reply) => reply.id === created.id) ? 0 : 1) } : comment) : [created, ...current.filter((comment) => comment.id !== created.id)]); if (isReply) { setReplyBody(""); setReplyTo(null); } else { setBody(""); } pendingKey.current = null;
    } catch (reason) { (isReply ? setReplyError : setError)(reason instanceof Error ? reason.message : "Your comment could not be posted."); }
    finally { posting.current = false; setSending(false); }
  }

  async function loadMore() {
    if (focusedCommentId || !nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    const generation = listGeneration.current;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`${base}?cursor=${encodeURIComponent(nextCursor)}&sort=${sort}`, { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "More comments could not be loaded.");
      if (generation !== listGeneration.current) return;
      const values: unknown[] = data.items ?? [];
      const incoming = values.map(normalizeComment).filter((item): item is MarketComment => Boolean(item));
      setComments((current) => [...current, ...incoming.filter((item) => !current.some((existing) => existing.id === item.id))]); setNextCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
    } catch (reason) { if (generation === listGeneration.current) setError(reason instanceof Error ? reason.message : "More comments could not be loaded."); }
    finally { loadingMore.current = false; if (generation === listGeneration.current) setLoading(false); }
  }

  async function loadReplies(comment: MarketComment) {
    if (!comment.repliesNextCursor || repliesInFlight.current.has(comment.id)) return;
    repliesInFlight.current.add(comment.id);
    setLoadingReplies((current) => [...current, comment.id]);
    const generation = listGeneration.current;
    try {
      const response = await fetch(`/api/comments/${encodeURIComponent(comment.id)}/replies?cursor=${encodeURIComponent(comment.repliesNextCursor)}`, { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? "Replies could not be loaded.");
      if (generation !== listGeneration.current) return;
      const incoming = (Array.isArray(data.items) ? data.items : []).map(normalizeComment).filter((item: MarketComment | null): item is MarketComment => Boolean(item));
      replaceComment(comment.id, (current) => ({ ...current,
        replies: [...(current.replies ?? []), ...incoming.filter((item: MarketComment) => !current.replies?.some((existing) => existing.id === item.id))].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)),
        repliesNextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
      }));
    } catch (reason) { if (generation === listGeneration.current) setError(reason instanceof Error ? reason.message : "Replies could not be loaded."); }
    finally { repliesInFlight.current.delete(comment.id); if (generation === listGeneration.current) setLoadingReplies((current) => current.filter((id) => id !== comment.id)); }
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
    setError(null);
    try {
    const response = await apiFetch(`/api/comments/${editing.id}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: editBody.trim() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { setError(data?.error?.message ?? "Comment could not be edited."); return; }
    const updated = normalizeComment(data.comment);
    if (updated) replaceComment(editing.id, (current) => ({ ...current, body: updated.body, editedAt: updated.editedAt, status: updated.status }));
    setEditing(null); setEditBody("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be edited."); }
  }

  async function remove(comment: MarketComment) {
    if (!window.confirm("Delete this comment? Replies will remain visible.")) return;
    setError(null);
    try {
    const response = await apiFetch(`/api/comments/${comment.id}`, { method: "DELETE", credentials: "same-origin" });
    if (!response.ok) { const data = await response.json().catch(() => ({})); setError(data?.error?.message ?? "Comment could not be deleted."); return; }
    replaceComment(comment.id, (item) => ({ ...item, body: "[deleted]", status: "DELETED" }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Comment could not be deleted."); }
  }

  function commentContent(comment: MarketComment, rootId: string) {
    const replying = replyTo?.comment.id === comment.id;
    return <>
      <header><strong>{comment.author.displayName}</strong>{comment.author.badge && <span className="author-badge">{comment.author.badge}</span>}<time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time></header>
      <p>{comment.status === "DELETED" ? <em>This comment was deleted.</em> : comment.body}</p>
      {comment.status !== "DELETED" && <footer>
        <button type="button" disabled={sending} aria-expanded={replying} aria-controls={replying ? `reply-form-${comment.id}` : undefined} onClick={() => { setReplyTo({ comment, rootId }); setReplyError(null); }}><Reply /> Reply</button>
        {currentUserId === comment.author.id ? <>
          <button type="button" onClick={() => { setEditing(comment); setEditBody(comment.body); }}><Pencil /> Edit</button>
          <button type="button" onClick={() => void remove(comment)}><Trash2 /> Delete</button>
        </> : currentUserId && <button type="button" onClick={() => setReporting(comment)}><Flag /> Report</button>}
      </footer>}
      {replying && <form id={`reply-form-${comment.id}`} className={`comment-composer ${styles.replyComposer}`} onSubmit={(event) => void submit(event, true)}>
        <label htmlFor={`reply-body-${comment.id}`}>Reply to {comment.author.displayName}</label>
        <textarea ref={replyInput} id={`reply-body-${comment.id}`} value={replyBody} maxLength={maxLength} rows={3} disabled={!canPost || sending} onChange={(event) => setReplyBody(event.target.value)} placeholder={canPost ? "Add a reply…" : "Sign in to reply"} />
        {canPost === false && <p><Link href={`/login?next=${encodeURIComponent(`${marketHref}?comment=${comment.id}#discussion-heading`)}`}>Sign in to reply</Link></p>}
        {replyError && <p className="form-error" role="alert">{replyError}</p>}
        <div><span>{replyBody.length}/{maxLength}</span><div className={styles.replyActions}>
          <button type="button" className="button button-ghost" disabled={sending} onClick={() => { setReplyTo(null); setReplyError(null); document.querySelector<HTMLButtonElement>(`#comment-${comment.id} > .comment-content > footer > button`)?.focus(); }}>Cancel</button>
          <button className="button button-primary" disabled={!canPost || !replyBody.trim() || sending}>{sending ? "Posting…" : "Post reply"}</button>
        </div></div>
      </form>}
    </>;
  }

  return (
    <section className={`comments-section ${styles.discussion}`} aria-labelledby="discussion-heading">
      <div className="section-heading"><div><span className="eyebrow">Community</span><h2 id="discussion-heading">Discussion</h2></div><span className="comment-count"><MessageCircle /> {comments.length}</span></div>
      {focusedCommentId && <p className="status-message">Linked discussion · <Link href={`${marketHref}#discussion-heading`}>View all discussion</Link></p>}
      <form className="comment-composer" onSubmit={submit}>
        <label htmlFor="comment-body">Add a comment</label>
        <textarea id="comment-body" value={body} maxLength={maxLength} rows={3} disabled={!canPost || sending} onChange={(event) => setBody(event.target.value)} placeholder={canPost === null ? "Checking your account..." : canPost ? "What do you think, and why?" : "Sign in to join the discussion"} />
        {canPost === false && <p className="signed-out-guidance"><Link href={`/login?next=${encodeURIComponent(returnHref)}`}>Sign in</Link> to comment, reply, or report a problem.</p>}
        <div><span className={body.length > maxLength * .9 ? "near-limit" : ""}>{body.length}/{maxLength}</span><button className="button button-primary" disabled={!canPost || !body.trim() || sending}>{sending ? "Posting…" : "Post"}</button></div>
      </form>
      {reporting && <form className="report-form" onSubmit={report}><div><strong>Report comment by {reporting.author.displayName}</strong><button type="button" onClick={() => setReporting(null)} aria-label="Cancel report"><X /></button></div><label>Reason<select name="reason" defaultValue="HARASSMENT"><option value="HARASSMENT">Harassment</option><option value="PRIVATE_INFORMATION">Private information</option><option value="SPAM">Spam</option><option value="MANIPULATION">Market manipulation</option><option value="OTHER">Other</option></select></label><label>Details<textarea name="details" maxLength={500} rows={3} /></label><button className="button button-secondary">Send report</button></form>}
      {editing && <form className="report-form" onSubmit={saveEdit}><div><strong>Edit your comment</strong><button type="button" onClick={() => setEditing(null)} aria-label="Cancel edit"><X /></button></div><label>Comment<textarea value={editBody} onChange={(event) => setEditBody(event.target.value)} maxLength={maxLength} rows={4} required /></label><button className="button button-secondary">Save edit</button></form>}
      {reportMessage && <p className="status-message" role="status">{reportMessage}</p>}
      {error && <p className="form-error" role="alert"><AlertCircle /><span>{error} <button onClick={retryLoad}>Retry</button></span></p>}
      <div className="comment-toolbar">{!focusedCommentId && <div className="segmented compact" role="group" aria-label="Sort comments"><button type="button" aria-pressed={sort === "top"} className={sort === "top" ? "active" : ""} onClick={() => { if (sort === "top") return; setLoading(true); setError(null); setSort("top"); }}>Most replies</button><button type="button" aria-pressed={sort === "newest"} className={sort === "newest" ? "active" : ""} onClick={() => { if (sort === "newest") return; setLoading(true); setError(null); setSort("newest"); }}>Newest</button></div>}<button type="button" className="button button-ghost" disabled={loading || sending} onClick={retryLoad}>Refresh discussion</button></div>
      {loading ? <LoadingState rows={3} label="Loading comments" /> : comments.length === 0 ? <EmptyState title={focusedCommentId ? "Comment unavailable" : "No comments yet"} description={focusedCommentId ? "This comment may have been removed. You can still read the rest of the discussion." : "Share what you think and why."} /> : (
        <><div className="comment-list">{[...comments].sort((a, b) => sort === "top" ? (b.replyCount ?? 0) - (a.replyCount ?? 0) : Date.parse(b.createdAt) - Date.parse(a.createdAt)).map((comment) => (
          <article id={`comment-${comment.id}`} data-linked={comment.id === focusedCommentId || undefined} className="comment" key={comment.id}>
            <div className="comment-avatar" aria-hidden="true">{initials(comment.author.displayName)}</div>
            <div className={`comment-content ${styles.content}`}>
              {commentContent(comment, comment.id)}
              {!!comment.replyCount && <p className={styles.replyCount}>{comment.replyCount} {comment.replyCount === 1 ? "reply" : "replies"}</p>}
              {!!comment.replies?.length && <div className="comment-replies" aria-label={`Replies to ${comment.author.displayName}`}>
                {comment.replies.map((reply) => (
                  <article id={`comment-${reply.id}`} data-linked={reply.id === focusedCommentId || undefined} className="comment reply-comment" key={reply.id}>
                    <div className="comment-avatar" aria-hidden="true">{initials(reply.author.displayName)}</div>
                    <div className={`comment-content ${styles.content}`}>{commentContent(reply, comment.id)}</div>
                  </article>
                ))}
              </div>}
              {comment.repliesNextCursor && <button type="button" className="button button-ghost" disabled={loadingReplies.includes(comment.id)} onClick={() => void loadReplies(comment)}>{loadingReplies.includes(comment.id) ? "Loading replies…" : "Load more replies"}</button>}
            </div>
          </article>
        ))}</div>{!focusedCommentId && nextCursor && <button className="button button-secondary load-more" onClick={() => void loadMore()} disabled={loading}>Load more discussion</button>}</>
      )}
    </section>
  );
}
