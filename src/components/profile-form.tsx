"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-api";
import styles from "./settings.module.css";

type Profile = { username: string; bio: string; profilePublic: boolean; leaderboardVisible: boolean };
export function ProfileForm({ profile, privacyOnly = false }: { profile: Profile; privacyOnly?: boolean }) {
  const router = useRouter();
  const [saved, setSaved] = useState(profile);
  const [draft, setDraft] = useState(profile);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const dirty = privacyOnly ? draft.profilePublic !== saved.profilePublic || draft.leaderboardVisible !== saved.leaderboardVisible : draft.username !== saved.username || draft.bio !== saved.bio;
  function update(patch: Partial<Profile>) { setDraft((current) => ({ ...current, ...patch })); setMessage(null); setError(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !dirty) return;
    pending.current = true; setBusy(true); setError(null); setMessage(null);
    const payload = privacyOnly ? { profilePublic: draft.profilePublic, leaderboardVisible: draft.leaderboardVisible } : { username: draft.username, bio: draft.bio };
    try {
      const response = await apiFetch("/api/profile", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "Changes could not be saved.");
      const updated: Profile = { ...draft, ...body.profile };
      setDraft(updated); setSaved(updated); setMessage(privacyOnly ? "Privacy choices saved." : "Profile saved."); router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Changes could not be saved."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <form className="stacked-form" onSubmit={submit} aria-busy={busy}>
    {privacyOnly ? <>
      <label className="checkbox-field"><input type="checkbox" checked={draft.profilePublic} disabled={busy} onChange={(event) => update({ profilePublic: event.target.checked })} /><span><strong>Public profile</strong><small>Show your profile and username next to your trades. Your market comments are always public.</small></span></label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.leaderboardVisible} disabled={busy} onChange={(event) => update({ leaderboardVisible: event.target.checked })} /><span><strong>Appear on the leaderboard</strong><small>Let people see where you rank.</small></span></label>
    </> : <>
      <label>Username<input name="username" autoComplete="username" value={draft.username} onChange={(event) => update({ username: event.target.value })} disabled={busy} minLength={3} maxLength={24} pattern="[a-zA-Z0-9][a-zA-Z0-9_]{1,22}[a-zA-Z0-9]" title="Use 3–24 letters, numbers, or underscores. Start and end with a letter or number." required aria-describedby="settings-username-hint" /><small id="settings-username-hint" className="field-hint">3–24 letters, numbers, or underscores. Start and end with a letter or number. Changing this also changes your public profile link.</small></label>
      <label>Bio<textarea name="bio" value={draft.bio} onChange={(event) => update({ bio: event.target.value })} disabled={busy} maxLength={280} rows={3} aria-describedby="settings-bio-hint" /><small id="settings-bio-hint" className="field-hint">{draft.bio.length}/280 characters</small></label>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="success-message" role="status">{message}</p>}
    <div className={styles.actions}><button className="button button-primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button><button type="button" className="button button-ghost" disabled={busy || !dirty} onClick={() => { setDraft(saved); setError(null); setMessage(null); }}>Cancel</button></div>
  </form>;
}
