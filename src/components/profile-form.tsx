"use client";

import { FormEvent, useState } from "react";
import { apiFetch } from "@/lib/client-api";

export function ProfileForm({ profile }: { profile: { displayName: string; bio: string; profilePublic: boolean; leaderboardVisible: boolean } }) {
  const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setMessage(null); const form = new FormData(event.currentTarget);
    try {
      const response = await apiFetch("/api/profile", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: form.get("displayName"), bio: form.get("bio"), profilePublic: form.get("profilePublic") === "on", leaderboardVisible: form.get("leaderboardVisible") === "on" }) });
      const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body?.error?.message ?? "Profile could not be saved."); setMessage("Profile and privacy choices saved.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Profile could not be saved."); } finally { setBusy(false); }
  }
  return <form className="stacked-form" onSubmit={submit} aria-busy={busy}><label>Display name<input name="displayName" defaultValue={profile.displayName} minLength={2} maxLength={40} required /></label><label>Bio<textarea name="bio" defaultValue={profile.bio} maxLength={280} rows={4} /></label><label className="checkbox-field"><input type="checkbox" name="profilePublic" defaultChecked={profile.profilePublic} /><span>Show my public profile and discussion history</span></label><label className="checkbox-field"><input type="checkbox" name="leaderboardVisible" defaultChecked={profile.leaderboardVisible} /><span>Include me in the public leaderboard</span></label>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="success-message" role="status">{message}</p>}<button className="button button-primary" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button></form>;
}
