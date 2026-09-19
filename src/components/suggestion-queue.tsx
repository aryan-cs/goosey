"use client";

import { useState } from "react";

type Suggestion = {
  id: string;
  title: string;
  description: string;
  category: string;
  createdAt: string | Date;
  user: { username: string; displayName: string };
};

export function SuggestionQueue({ initialSuggestions }: { initialSuggestions: Suggestion[] }) {
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [error, setError] = useState<string | null>(null);

  async function review(id: string, action: "APPROVE" | "REJECT") {
    const note = window.prompt(action === "APPROVE" ? "Explain why this is ready for market drafting" : "Explain why this cannot be listed");
    if (!note || note.trim().length < 3) return;
    const response = await fetch(`/api/admin/suggestions/${id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, note: note.trim() }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body?.error?.message ?? "Suggestion review failed.");
      return;
    }
    setSuggestions((current) => current.filter((suggestion) => suggestion.id !== id));
  }

  return <section className="moderation-panel"><div className="section-heading"><div><span className="eyebrow">Community markets</span><h2>Suggestion queue</h2></div><span>{suggestions.length} pending</span></div>{error && <p className="form-error">{error}</p>}{suggestions.length ? <div className="report-list">{suggestions.map((suggestion) => <article className="report-item" key={suggestion.id}><header><strong>{suggestion.title}</strong><span>{suggestion.category}</span></header><p>{suggestion.description}</p><footer><span>submitted by @{suggestion.user.username}</span><button className="button button-ghost" onClick={() => void review(suggestion.id, "REJECT")}>Reject</button><button className="button button-secondary" onClick={() => void review(suggestion.id, "APPROVE")}>Approve for drafting</button></footer></article>)}</div> : <p className="muted-copy">No pending suggestions.</p>}</section>;
}
