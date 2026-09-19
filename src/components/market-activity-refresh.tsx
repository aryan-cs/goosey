"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

/** Refresh server-rendered market activity without resetting the trade form. */
export function MarketActivityRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    function refresh() {
      if (pending || document.visibilityState !== "visible" || !navigator.onLine) return;
      startTransition(() => router.refresh());
    }

    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, pending]);

  return null;
}
