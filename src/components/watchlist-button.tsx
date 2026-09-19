"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client-api";

export function WatchlistButton({ marketId, signedIn, icon }: { marketId: string; signedIn?: boolean; icon: ReactNode }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [authenticated, setAuthenticated] = useState(Boolean(signedIn));
  const router = useRouter();
  useEffect(() => {
    if (signedIn === false) return;
    const controller = new AbortController();
    const discover = signedIn === undefined
      ? fetch("/api/auth/session", { signal: controller.signal }).then((response) => response.ok ? response.json() : null).then((data) => Boolean(data?.user))
      : Promise.resolve(true);
    void discover.then((active) => { setAuthenticated(active); return active ? fetch("/api/watchlist", { signal: controller.signal }) : null; })
      .then((response) => response?.ok ? response.json() : null)
      .then((data) => setSaved(Boolean(data?.items?.some((item: { marketId: string }) => item.marketId === marketId))))
      .catch(() => undefined);
    return () => controller.abort();
  }, [marketId, signedIn]);
  async function toggle() {
    if (!authenticated) { router.push("/login"); return; }
    setBusy(true); setFailed(false);
    try {
      const response = await apiFetch("/api/watchlist", { method: saved ? "DELETE" : "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ marketId }) });
      if (!response.ok) throw new Error("Watchlist update failed");
      const next = !saved;
      setSaved(next);
      setFeedback(next ? "Saved" : "Removed");
      window.setTimeout(() => setFeedback(""), 1600);
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return <button className={`icon-button${saved ? " watchlist-saved" : ""}`} aria-label={failed ? "Watchlist update failed; retry" : saved ? "Remove from watchlist" : "Add to watchlist"} aria-pressed={saved} disabled={busy} onClick={toggle} title={failed ? "Update failed. Try again." : undefined} type="button">{icon}<span className={`icon-button-feedback${failed || feedback ? " visible" : ""}`} role="status">{failed ? "Try again" : feedback}</span></button>;
}
