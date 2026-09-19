"use client";

import Link from "next/link";
import { FormEvent, useState, useSyncExternalStore } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, LockKeyhole, Mail } from "lucide-react";

function fragmentToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token")?.trim();
  return token || null;
}

function subscribeToHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function PasswordResetFlow() {
  const token = useSyncExternalStore(subscribeToHash, fragmentToken, () => null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email") ?? "").trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "Password recovery is temporarily unavailable.");
      setMessage("If that account is eligible, a reset link is on its way. Check your inbox and spam folder.");
      event.currentTarget.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password recovery is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (newPassword !== confirmation) {
      setError("The passwords do not match.");
      setSubmitting(false);
      return;
    }
    try {
      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message ?? "That reset link could not be used.");
      window.history.replaceState(null, "", window.location.pathname);
      setSuccess(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That reset link could not be used.");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return <section className="auth-card verification-card"><div className="verification-state" role="status"><CheckCircle2 className="verification-success-icon" /><span className="eyebrow">Password updated</span><h1>Your account is secure</h1><p>All existing sessions were signed out. Use your new password to continue.</p><Link className="button button-primary" href="/login">Sign in</Link></div></section>;
  }

  const confirming = token !== null;
  return (
    <section className="auth-card verification-card" aria-labelledby="password-reset-heading">
      <span className="eyebrow">Account recovery</span>
      <h1 id="password-reset-heading">{confirming ? "Choose a new password" : "Reset your password"}</h1>
      <p>{confirming ? "Use at least 12 characters. Completing this reset signs out every existing session." : "Enter your account email. We will send a time-limited, one-use reset link if the account is eligible."}</p>
      <form onSubmit={confirming ? submitConfirmation : submitRequest}>
        {confirming ? <>
          <label><span>New password</span><div className="input-with-icon"><LockKeyhole /><input name="newPassword" type="password" autoComplete="new-password" minLength={12} required /></div></label>
          <label><span>Confirm new password</span><div className="input-with-icon"><LockKeyhole /><input name="confirmation" type="password" autoComplete="new-password" minLength={12} required /></div></label>
        </> : <label><span>Email</span><div className="input-with-icon"><Mail /><input name="email" type="email" autoComplete="email" required /></div></label>}
        {error ? <p className="form-error" role="alert"><AlertCircle /> {error}</p> : null}
        {message ? <p className="success-message" role="status"><CheckCircle2 /> {message}</p> : null}
        <button className="button button-primary auth-submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" /> : null}{confirming ? "Update password" : "Send reset link"}</button>
      </form>
      <p className="auth-switch"><Link href="/login">Back to sign in</Link></p>
    </section>
  );
}
