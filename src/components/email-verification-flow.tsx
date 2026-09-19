"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, Mail, RotateCcw } from "lucide-react";
import { apiFetch, type ApiErrorBody } from "@/lib/client-api";
import { GooseMark } from "./brand";

type Phase = "loading" | "pending" | "confirming" | "success" | "invalid";
type SessionPayload = { authenticated?: boolean; user?: { email?: string }; emailVerification?: { required?: boolean } | null };

function safeNext(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/verify-email")) return "/";
  return value;
}

function maskEmail(value: string) {
  const [name, domain] = value.split("@");
  if (!domain) return value;
  return `${name.slice(0, 2)}${"•".repeat(Math.max(2, Math.min(6, name.length - 2)))}@${domain}`;
}

async function readBody(response: Response) {
  return response.json().catch(() => ({})) as Promise<ApiErrorBody & Record<string, unknown>>;
}

export function EmailVerificationFlow() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [email, setEmail] = useState("");
  const [signedInEmail, setSignedInEmail] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const next = safeNext(new URLSearchParams(window.location.search).get("next"));
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    const requested = sessionStorage.getItem("goosey:verification-request-status");
    sessionStorage.removeItem("goosey:verification-request-status");

    async function loadSession() {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
      const data = await response.json().catch(() => ({})) as SessionPayload;
      if (data.authenticated && data.user?.email) {
        setEmail(data.user.email);
        setSignedInEmail(true);
      }
      return data;
    }

    async function start() {
      if (!token) {
        const session = await loadSession();
        if (session.authenticated && !session.emailVerification?.required) {
          window.location.replace(next);
          return;
        }
        if (requested === "sent") setMessage("We sent a verification link. Check your inbox and spam folder.");
        if (requested === "failed") setError("Your account is ready, but we could not send the email. Try again below.");
        setPhase("pending");
        return;
      }

      setPhase("confirming");
      const response = await apiFetch("/api/auth/email-verification/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await readBody(response);
      if (!response.ok) {
        await loadSession();
        setError(body.error?.message ?? "That verification link is invalid or has expired.");
        setPhase("invalid");
        return;
      }

      await Promise.all([
        fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/me", { credentials: "same-origin", cache: "no-store" }),
      ]);
      setMessage(body.welcomeGrantIssued ? "Email verified. Your 10,000 feathers are ready." : "Email verified. You are ready to go.");
      setPhase("success");
      window.setTimeout(() => window.location.replace(next), 900);
    }

    start().catch(() => {
      setError("We could not check your verification status. Try again.");
      setPhase("pending");
    });
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email || sending || cooldown > 0) return;
    setSending(true); setError(null); setMessage(null);
    try {
      const response = await apiFetch("/api/auth/email-verification/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await readBody(response);
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("Retry-After") ?? 0);
        if (retryAfter > 0) setCooldown(retryAfter);
        throw new Error(body.error?.message ?? "We could not send another email.");
      }
      setMessage("If this account can be verified, a new link will arrive shortly.");
      setCooldown(60);
      setPhase("pending");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "We could not send another email.");
    } finally { setSending(false); }
  }

  return (
    <section className="auth-card verification-card" aria-labelledby="verification-heading">
      <div className="auth-brand"><GooseMark /><span>Goosey</span></div>
      {phase === "loading" || phase === "confirming" ? <div className="verification-state" role="status"><LoaderCircle className="spin" /><span className="eyebrow">One moment</span><h1 id="verification-heading">{phase === "confirming" ? "Checking your link" : "Checking your account"}</h1><p>This should only take a second.</p></div>
      : phase === "success" ? <div className="verification-state" role="status"><CheckCircle2 className="verification-success-icon" /><span className="eyebrow">All set</span><h1 id="verification-heading">You are verified</h1><p>{message}</p></div>
      : <>
        <span className="eyebrow">Almost there</span>
        <h1 id="verification-heading">Check your email</h1>
        <p>{signedInEmail ? <>We sent a link to <strong>{maskEmail(email)}</strong>. Open it on this device to finish setting up Goosey.</> : "Enter your account email and we will send a fresh verification link."}</p>
        {message && <p className="success-message" role="status"><CheckCircle2 /> {message}</p>}
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}
        <form onSubmit={resend}>
          {!signedInEmail && <label><span>Email</span><div className="input-with-icon"><Mail /><input autoComplete="email" type="email" value={email} required onChange={(event) => setEmail(event.currentTarget.value)} /></div></label>}
          <button className="button button-primary auth-submit" disabled={sending || cooldown > 0}>{sending ? <LoaderCircle className="spin" /> : <RotateCcw />}{cooldown > 0 ? `Send again in ${cooldown}s` : phase === "invalid" ? "Send a new link" : "Resend email"}</button>
        </form>
        <p className="auth-switch"><Link href="/login">Use a different account</Link></p>
      </>}
    </section>
  );
}
