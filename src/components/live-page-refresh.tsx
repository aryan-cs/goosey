"use client";

import { useCallback, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Refresh server-rendered activity without discarding the current page or cursor. */
export function LivePageRefresh({ showButton = true }: { showButton?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = useCallback(() => {
    if (document.visibilityState !== "visible" || !navigator.onLine || pending) return;
    startTransition(() => router.refresh());
  }, [router, pending]);

  useEffect(() => {
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refresh]);

  if (!showButton) return null;

  return <button className="button button-secondary" type="button" onClick={refresh} disabled={pending} aria-label="Refresh latest activity">{pending ? "Refreshing…" : "Refresh"}</button>;
}
