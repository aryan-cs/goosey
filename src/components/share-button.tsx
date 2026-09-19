"use client";

import { useState, type ReactNode } from "react";

export function ShareButton({ title, icon }: { title: string; icon: ReactNode }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    if (navigator.share) await navigator.share({ title, url: window.location.href });
    else { await navigator.clipboard.writeText(window.location.href); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
  }
  return <button className="icon-button" aria-label={copied ? "Market link copied" : "Share market"} title={copied ? "Link copied" : "Share market"} onClick={() => void share()} type="button">{icon}<span className={`icon-button-feedback${copied ? " visible" : ""}`} role="status">Copied</span></button>;
}
