"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle, Mail, RotateCcw } from "lucide-react";
import { apiFetch, type ApiErrorBody } from "@/lib/client-api";
import { GooseMark } from "./brand";
import { authDestination, authPageHref } from "@/lib/auth-destination";

type Phase = "loading" | "pending" | "confirming" | "success" | "invalid";
type SessionPayload = { authenticated?: boolean; user?: { email?: string; emailVerifiedAt?: string | null }; emailVerification?: { required?: boolean } | null };

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
  const [verifiedSession, setVerifiedSession] = useState(false);
  const [destination, setDestination] = useState("/");

  useEffect(() => {
    let active = true;
    let generation = 0;
    let controller: AbortController | null = null;
    let redirectTimer: number | undefined;
    let previousHash: string | undefined;
    const requested = sessionStorage.getItem("goosey:verification-request-status");

    async function loadSession(signal: AbortSignal, current: () => boolean) {
      const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("Session could not be checked.");
      const data = await response.json().catch(() => ({})) as SessionPayload;
      if (current()) setSignedInEmail(Boolean(data.authenticated && data.user?.email));
      if (current() && data.authenticated && data.user?.email) {
        setEmail(data.user.email);
        setSignedInEmail(true);
      }
      return data;
    }

    async function start(token: string | null, next: string, signal: AbortSignal, current: () => boolean) {
      if (!token) {
        const session = await loadSession(signal, current);
        if (!current()) return;
        sessionStorage.removeItem("goosey:verification-request-status");
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
        signal,
      });
      const body = await readBody(response);
      if (!current()) return;
      if (!response.ok) {
        const session = await loadSession(signal, current).catch(() => null);
        if (!current()) return;
        // This establishes only the current session's status, never the token's
        // identity or success. A consumed or unrelated link remains rejected.
        setVerifiedSession(Boolean(session?.authenticated && session.user?.emailVerifiedAt && session.emailVerification?.required === false));
        setError(body.error?.message ?? "That verification link is invalid or has expired.");
        setPhase("invalid");
        return;
      }

      const requiresSignIn = body.requiresSignIn === true;
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setMessage(requiresSignIn
        ? "Email verified. Sign in to the account you just verified to continue."
        : body.welcomeGrantIssued ? "Email verified. Your feathers are ready." : "Email verified. You are ready to go.");
      setPhase("success");
      redirectTimer = window.setTimeout(() => { if (current()) window.location.replace(requiresSignIn ? authPageHref("/login", next) : next); }, 900);
    }

    function checkLink() {
      if (previousHash === window.location.hash) return;
      previousHash = window.location.hash;
      controller?.abort();
      controller = new AbortController();
      window.clearTimeout(redirectTimer);
      const signal = controller.signal;
      const requestGeneration = ++generation;
      const current = () => active && !signal.aborted && generation === requestGeneration;
      const next = authDestination(new URLSearchParams(window.location.search).get("next"));
      setDestination(next);
      setVerifiedSession(false);
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      setError(null);
      setMessage(null);
      void start(token, next, signal, current).catch(() => {
        if (!current()) return;
        setError("We could not check your verification status. Try again.");
        setPhase("pending");
      });
    }

    window.addEventListener("hashchange", checkLink);
    const initialCheck = window.setTimeout(checkLink, 0);
    return () => {
      active = false;
      controller?.abort();
      window.clearTimeout(initialCheck);
      window.clearTimeout(redirectTimer);
      window.removeEventListener("hashchange", checkLink);
    };
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
        body: JSON.stringify({ email, next: authDestination(new URLSearchParams(window.location.search).get("next")) }),
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
        <h1 id="verification-heading">{phase === "invalid" ? "Verification link unavailable" : "Check your email"}</h1>
        <p>{verifiedSession ? "Your currently signed-in account is already verified. You can continue with that account; this does not confirm the rejected link." : signedInEmail ? <>Verify <strong>{maskEmail(email)}</strong> to finish setting up Goosey. You can request a new link below.</> : "Enter your account email to request a verification link, or sign in to an already-verified account."}</p>
        {message && <p className="success-message" role="status"><CheckCircle2 /> {message}</p>}
        {error && <p className="form-error" role="alert"><AlertCircle /> {error}</p>}
        {verifiedSession ? <Link className="button button-primary auth-submit" href={destination}>Continue</Link> : <form onSubmit={resend}>
          {!signedInEmail && <label><span>Email</span><div className="input-with-icon"><Mail /><input autoComplete="email" type="email" value={email} required onChange={(event) => setEmail(event.currentTarget.value)} /></div></label>}
          <button className="button button-primary auth-submit" disabled={sending || cooldown > 0}>{sending ? <LoaderCircle className="spin" /> : <RotateCcw />}{cooldown > 0 ? `Send again in ${cooldown}s` : phase === "invalid" ? "Send a new link" : "Resend email"}</button>
        </form>}
        <p className="auth-switch"><Link href={authPageHref("/login", destination)}>{phase === "invalid" && !verifiedSession ? "Sign in to continue" : "Use a different account"}</Link></p>
      </>}
    </section>
  );
}
