"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-api";
import styles from "./settings.module.css";
import type { NotificationPreferencesValue } from "@/lib/notification-preferences";

const options: { key: keyof NotificationPreferencesValue; label: string; description: string }[] = [
  { key: "trades", label: "Trading activity", description: "Trade confirmations and complete-set redemptions." },
  { key: "resolutions", label: "Market results", description: "Results and settlements for your markets." },
  { key: "replies", label: "Replies to your comments", description: "When someone joins your conversation." },
  { key: "suggestions", label: "Market suggestion updates", description: "When your submitted market idea has been reviewed." },
];
function readPreferences(value: unknown): NotificationPreferencesValue {
  if (!value || typeof value !== "object" || !options.every(({ key }) => typeof (value as Record<string, unknown>)[key] === "boolean")) {
    throw new Error("Notification settings could not be read. Please try again.");
  }
  return value as NotificationPreferencesValue;
}

export function NotificationPreferences() {
  const router = useRouter();
  const [preferences, setPreferences] = useState<NotificationPreferencesValue | null>(null);
  const [saved, setSaved] = useState<NotificationPreferencesValue | null>(null);
  const dirty = preferences && saved && options.some(({ key }) => preferences[key] !== saved[key]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/settings/notifications", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body?.error?.message ?? "Notification settings could not be loaded.");
        if (!controller.signal.aborted) { const next = readPreferences(body.preferences); setPreferences(next); setSaved(next); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Notification settings could not be loaded.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [revision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preferences || !dirty || pending.current) return;
    pending.current = true; setSaving(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch("/api/settings/notifications", { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(preferences) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "Notification settings could not be saved.");
      const next = readPreferences(body.preferences); setPreferences(next); setSaved(next);
      setMessage("Notification preferences saved.");
      router.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Notification settings could not be saved."); }
    finally { pending.current = false; setSaving(false); }
  }

  return <form className="stacked-form" onSubmit={submit} aria-busy={loading || saving}>
    <p>Choose what appears in your Goosey inbox and unread badge. Turning a category off hides its existing and future notices; turning it back on restores them. Your notification history is kept.</p>
    {loading && <p role="status">Loading notification preferences…</p>}
    {preferences && options.map(({ key, label, description }) => <label className="checkbox-field" key={key}>
      <input type="checkbox" checked={preferences[key]} disabled={saving || loading} onChange={(event) => { setPreferences({ ...preferences, [key]: event.target.checked }); setMessage(null); setError(null); }} aria-describedby={`notification-${key}-description`} />
      <span><strong>{label}</strong><small id={`notification-${key}-description`}>{description}</small></span>
    </label>)}
    <p>Account safety and moderation notices always stay visible. These settings only apply inside Goosey.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="success-message" role="status">{message}</p>}
    {!preferences && !loading ? <button type="button" className="button button-secondary" onClick={() => { setError(null); setLoading(true); setRevision((value) => value + 1); }}>Try again</button> : <div className={styles.actions}><button className="button button-primary" disabled={!dirty || loading || saving}>{saving ? "Saving…" : "Save changes"}</button><button type="button" className="button button-ghost" disabled={!dirty || loading || saving} onClick={() => { setPreferences(saved); setMessage(null); setError(null); }}>Cancel</button></div>}
  </form>;
}
