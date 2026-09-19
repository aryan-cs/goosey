"use client";

import Link from "next/link";
import styles from "./auth-registration.module.css";
import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, UserRound } from "lucide-react";
import { GooseMark } from "./brand";

export interface AuthFormProps {
  mode: "login" | "register";
  endpoint?: string;
  csrfToken?: string;
  redirectTo?: string;
  onSuccess?: (response: unknown) => void;
}

function idempotencyKey() { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export function AuthForm({ mode, endpoint, csrfToken, redirectTo = "/", onSuccess }: AuthFormProps) {
  const router = useRouter();
  const register = mode === "register";
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSubmitting(true); setError(null); keyRef.current ??= idempotencyKey();
    const form = new FormData(event.currentTarget);
    const payload = { email: String(form.get("email") ?? "").trim(), password: String(form.get("password") ?? ""), ...(register ? { username: String(form.get("username") ?? "").trim(), acceptedCodeOfConduct: form.get("acceptedCodeOfConduct") === "on" } : {}) };
    try {
      const response = await fetch(endpoint ?? `/api/auth/${register ? "register" : "login"}`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "Idempotency-Key": keyRef.current, ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.message ?? data?.message ?? `${register ? "Account creation" : "Sign in"} failed.`);
      keyRef.current = null; onSuccess?.(data);
      if (data?.emailVerification?.required) {
        if (register) {
          let requested = false;
          try {
            const verificationResponse = await fetch("/api/auth/email-verification/request", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: payload.email }) });
            requested = verificationResponse.ok;
          } catch { /* The verification screen offers a retry without discarding the new session. */ }
          sessionStorage.setItem("goosey:verification-request-status", requested ? "sent" : "failed");
        }
        const next = data?.redirectTo ?? redirectTo;
        router.push(`/verify-email?next=${encodeURIComponent(next)}`);
        return;
      }
      if (!onSuccess) window.location.assign(data?.redirectTo ?? redirectTo);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The request could not be completed."); }
    finally { setSubmitting(false); }
  }

  return (
    <section className={`auth-card${register ? ` ${styles.registration}` : ""}`} aria-labelledby="auth-heading">
      <div className="auth-brand"><GooseMark /><span>Goosey</span></div>
      <span className="eyebrow">{register ? "Join Goosey" : "Welcome back"}</span>
      <h1 id="auth-heading">{register ? "Create your account" : "Pick up where you left off"}</h1>
      <p>{register ? "Start with 10,000 play-money feathers." : "Sign in to trade, comment, and check your picks."}</p>
      <form onSubmit={submit}>
        {register && <label><span>Username</span><div className="input-with-icon"><UserRound /><input autoComplete="username" name="username" required minLength={3} maxLength={24} pattern="[a-zA-Z0-9_]+" aria-describedby="username-hint" /></div><small id="username-hint" className="field-hint">Letters, numbers, and underscores only.</small></label>}
        <label><span>Email</span><div className="input-with-icon"><Mail /><input autoComplete="email" name="email" type="email" required /></div></label>
        <div className="auth-field"><div className="auth-field-heading"><label htmlFor="auth-password">Password</label>{!register && <Link href="/reset-password">Forgot password?</Link>}</div><div className="input-with-icon"><LockKeyhole /><input id="auth-password" autoComplete={register ? "new-password" : "current-password"} name="password" type={showPassword ? "text" : "password"} required minLength={register ? 12 : undefined} /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff /> : <Eye />}</button></div></div>

        {register ? <label className="checkbox-field"><input type="checkbox" name="acceptedCodeOfConduct" required /><span>I agree to the <Link href="/rules">community rules and code of conduct</Link>.</span></label> : null}
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}
        <button className="button button-primary auth-submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" /> : null}{register ? "Create account" : "Sign in"}<ArrowRight /></button>
      </form>
      <p className="auth-switch">{register ? "Already have an account?" : "New to Goosey?"} <Link href={register ? "/login" : "/signup"}>{register ? "Sign in" : "Create an account"}</Link></p>
    </section>
  );
}
