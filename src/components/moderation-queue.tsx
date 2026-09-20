"use client";

import Link from "next/link";
import { useState } from "react";
import { UserProfileLink } from "./user-profile-link";

type Report = { id: string; reason: string; details: string; createdAt: string | Date; reporter: { username: string }; comment: { body: string; user: { username: string; displayName: string }; market: { slug: string; shortTitle: string } } };

export function ModerationQueue({ initialReports }: { initialReports: Report[] }) {
  const [reports, setReports] = useState(initialReports); const [error, setError] = useState<string | null>(null);
  async function resolve(id: string, action: "DISMISS" | "HIDE") {
    const note = window.prompt(action === "HIDE" ? "Explain why this comment is being hidden" : "Explain why this report is dismissed");
    if (!note || note.trim().length < 3) return;
    const response = await fetch(`/api/admin/reports/${id}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, note: note.trim() }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setError(body?.error?.message ?? "Moderation action failed."); return; }
    setReports((current) => current.filter((report) => report.id !== id));
  }
  return <section className="moderation-panel"><div className="section-heading"><div><span className="eyebrow">Community safety</span><h2>Report queue</h2></div><span>{reports.length} pending</span></div>{error && <p className="form-error">{error}</p>}{reports.length ? <div className="report-list">{reports.map((report) => <article className="report-item" key={report.id}><header><strong>{report.reason.replaceAll("_", " ")}</strong><span>reported by <UserProfileLink username={report.reporter.username}>@{report.reporter.username}</UserProfileLink></span></header><p>“{report.comment.body}”</p>{report.details && <small>{report.details}</small>}<footer><Link href={`/markets/${report.comment.market.slug}#discussion-heading`}>{report.comment.market.shortTitle}</Link><span>by <UserProfileLink username={report.comment.user.username}>@{report.comment.user.username}</UserProfileLink></span><button className="button button-ghost" onClick={() => void resolve(report.id, "DISMISS")}>Dismiss</button><button className="button button-secondary" onClick={() => void resolve(report.id, "HIDE")}>Hide comment</button></footer></article>)}</div> : <p className="muted-copy">No pending reports.</p>}</section>;
}
